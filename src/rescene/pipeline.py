"""End-to-end orchestration around the pinned upstream tools."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from PIL import Image

from rescene.backends import (
    colmap_command,
    gsplat_command,
    is_cuda_oom,
    is_vggt_ba_failure,
    run_command,
    vggt_command,
)
from rescene.config import ProfileConfig, profile_config
from rescene.metrics import (
    collect_metrics,
    final_ply_path,
    merge_evaluation_evidence,
    sha256_file,
    write_report,
)
from rescene.preprocess import classify_input, preprocess_input, relocate_selected_images
from rescene.stages import StageStore


def project_root() -> Path:
    return Path(os.environ.get("RESCENE_ROOT", Path.cwd())).resolve()


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


@contextmanager
def _timed(timings: dict[str, float], name: str):
    """Accumulate wall-clock seconds per pipeline stage, including fallbacks."""
    start = time.perf_counter()
    try:
        yield
    finally:
        timings[name] = round(timings.get(name, 0.0) + time.perf_counter() - start, 3)


def _source_tree_sha256(directory: Path) -> str | None:
    """Hash source contents and relative names, including uncommitted edits."""
    if not directory.is_dir():
        return None
    suffixes = {".py", ".pyi", ".c", ".cc", ".cpp", ".h", ".hpp", ".cu", ".cuh", ".rs", ".sh", ".toml", ".yaml", ".yml"}
    files = sorted(
        path
        for path in directory.rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and path.suffix.lower() in suffixes
        and not any(
            part in {".git", "__pycache__", "build", "dist", ".venv"} for part in path.relative_to(directory).parts
        )
    )
    digest = hashlib.sha256()
    for path in files:
        digest.update(f"{path.relative_to(directory).as_posix()}\0{sha256_file(path)}\n".encode())
    return digest.hexdigest()


def _environment(root: Path) -> dict[str, object]:
    revisions: dict[str, str | None] = {}
    for name in ("vggt", "gsplat", "spz", "dinov2"):
        path = root / "third_party" / name
        revision_file = path / ".revision"
        if revision_file.exists():
            revisions[name] = revision_file.read_text(encoding="utf-8").strip()
        else:
            result = subprocess.run(
                ["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True, check=False
            )
            revisions[name] = result.stdout.strip() or None
    return {
        "python": sys.version,
        "platform": platform.platform(),
        "git_revisions": revisions,
        "source_tree_sha256": _source_tree_sha256(root / "src" / "rescene"),
        "vendor_source_tree_sha256": {
            name: _source_tree_sha256(root / "third_party" / name) for name in ("vggt", "gsplat", "spz", "dinov2")
        },
        "vggt_checkpoint_sha256": next(
            (
                sha256_file(path)
                for path in (
                    root / ".cache/models/VGGT-1B/model.safetensors",
                    root / ".cache/models/VGGT-1B/model.pt",
                )
                if path.exists()
            ),
            None,
        ),
        "vggsfm_tracker_sha256": (
            sha256_file(root / ".cache/models/VGGSfM/vggsfm_v2_tracker.pt")
            if (root / ".cache/models/VGGSfM/vggsfm_v2_tracker.pt").exists()
            else None
        ),
        "dinov2_checkpoint_sha256": (
            sha256_file(root / ".cache/torch/hub/checkpoints/dinov2_vitb14_reg4_pretrain.pth")
            if (root / ".cache/torch/hub/checkpoints/dinov2_vitb14_reg4_pretrain.pth").exists()
            else None
        ),
    }


def _find_ply(run_dir: Path) -> Path:
    return final_ply_path(run_dir)


def _ensure_downsampled_images(scene_dir: Path, factor: int) -> None:
    if factor == 1:
        return
    destination = scene_dir / f"images_{factor}"
    if destination.exists() and any(destination.iterdir()):
        return
    destination.mkdir(parents=True, exist_ok=True)
    for source in sorted((scene_dir / "images").glob("*.jpg")):
        with Image.open(source) as image:
            size = (max(1, image.width // factor), max(1, image.height // factor))
            image.resize(size, Image.Resampling.LANCZOS).save(destination / source.name, quality=95)


def _run_dir_has_results(run_dir: Path) -> bool:
    return run_dir.exists() and any(entry.name not in {"launcher.log", "pid"} for entry in run_dir.iterdir())


def _sparse_has_points(run_dir: Path) -> bool:
    # shortcut: all current backends emit binary COLMAP models; add text parsing if that changes.
    return any(path.stat().st_size > 8 for path in (run_dir / "sparse").rglob("points3D.bin"))


def _clear_colmap_outputs(run_dir: Path) -> None:
    (run_dir / "database.db").unlink(missing_ok=True)
    for name in ("sparse", "dense"):
        shutil.rmtree(run_dir / name, ignore_errors=True)


def _run_sparse_colmap(
    root: Path,
    run_dir: Path,
    log_path: Path,
    *,
    sequential: bool,
    camera_model: str,
    mvs_max_image_size: int,
    poisson_depth: int,
) -> None:
    _clear_colmap_outputs(run_dir)
    run_command(
        colmap_command(
            run_dir,
            sequential=sequential,
            dense=False,
            camera_model=camera_model,
            mvs_max_image_size=mvs_max_image_size,
            poisson_depth=poisson_depth,
        ),
        log_path,
        cwd=root,
    )


def _reuse_files(directory: Path) -> list[Path]:
    required = [directory / "input_manifest.json", directory / "photometric_selection.json"]
    files = list(required)
    for name in ("images", "sparse"):
        tree = directory / name
        if not tree.is_dir() or tree.is_symlink():
            raise ValueError(f"Missing or unsafe reuse directory: {tree}")
        entries = sorted(tree.rglob("*"))
        if any(path.is_symlink() for path in entries):
            raise ValueError(f"Symlinks are not permitted in reuse artifacts: {tree}")
        files.extend(path for path in entries if path.is_file())
    if any(not path.is_file() or path.is_symlink() for path in required):
        raise ValueError("Reuse requires an input manifest and photometric selection")
    if not any(path.is_file() for path in (directory / "images").rglob("*")) or not _sparse_has_points(directory):
        raise ValueError("Reuse requires selected images and a nonempty sparse model")
    return sorted(files)


def _separate_directories(left: Path, right: Path) -> bool:
    return left != right and left not in right.parents and right not in left.parents


def create_reuse_bundle(source_run: Path, bundle_dir: Path) -> str:
    """Copy a successful run's inputs into a new, hash-addressed reuse bundle.

    The returned manifest SHA-256 must be supplied when using the bundle. The
    source run is never modified, and the bundle may not overlap it.
    """
    source_run = source_run.resolve()
    bundle_dir = bundle_dir.resolve()
    if not _separate_directories(source_run, bundle_dir):
        raise ValueError("Reuse bundle and source run must be separate")
    source_stages = {}
    for stage in ("preprocess", "geometry"):
        state_path = source_run / "stages" / f"{stage}.json"
        if not state_path.is_file():
            raise ValueError(f"Source run has no successful {stage} stage")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("status") != "success":
            raise ValueError(f"Source run has no successful {stage} stage")
        source_stages[stage] = state
    source_metadata = {}
    for name in ("config", "environment", "degradation"):
        path = source_run / f"{name}.json"
        if path.is_file():
            source_metadata[name] = json.loads(path.read_text(encoding="utf-8"))
    files = _reuse_files(source_run)
    hashes = {path.relative_to(source_run).as_posix(): sha256_file(path) for path in files}
    bundle_dir.mkdir(parents=True, exist_ok=False)
    for path in files:
        relative = path.relative_to(source_run)
        destination = bundle_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        if sha256_file(destination) != hashes[relative.as_posix()] or sha256_file(path) != hashes[relative.as_posix()]:
            raise ValueError(f"Source changed while creating reuse bundle: {relative}")
    if {path.relative_to(source_run).as_posix(): sha256_file(path) for path in _reuse_files(source_run)} != hashes:
        raise ValueError("Source artifacts changed while creating reuse bundle")
    manifest = {
        "schema_version": 1,
        "source_run": str(source_run),
        "files": hashes,
        "source_stages": source_stages,
        "source_metadata": source_metadata,
    }
    _write_json(bundle_dir / "reuse_manifest.json", manifest)
    return sha256_file(bundle_dir / "reuse_manifest.json")


def _verify_reuse_bundle(bundle_dir: Path, expected_sha256: str) -> dict[str, object]:
    manifest_path = bundle_dir / "reuse_manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file() or sha256_file(manifest_path) != expected_sha256:
        raise ValueError("Reuse manifest SHA-256 mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    hashes = manifest.get("files")
    if manifest.get("schema_version") != 1 or not isinstance(hashes, dict):
        raise ValueError("Invalid reuse manifest")
    files = _reuse_files(bundle_dir)
    actual = {path.relative_to(bundle_dir).as_posix(): sha256_file(path) for path in files}
    if actual != hashes:
        raise ValueError("Reuse artifact SHA-256 mismatch")
    return manifest


def _run_reuse_comparison(
    root: Path,
    run_dir: Path,
    config: ProfileConfig,
    bundle_dir: Path,
    bundle_sha256: str,
    stage: str,
) -> Path:
    if stage not in {"training", "dense"}:
        raise ValueError("Reuse stage must be training or dense")
    bundle_dir = bundle_dir.resolve()
    if not _separate_directories(run_dir, bundle_dir):
        raise ValueError("Reuse bundle and output run must be separate")
    if _run_dir_has_results(run_dir):
        raise FileExistsError(f"Reuse comparison requires a fresh output run: {run_dir}")
    timings: dict[str, float] = {}
    with _timed(timings, "reuse_prepare"):
        manifest = _verify_reuse_bundle(bundle_dir, bundle_sha256)
        source_run = Path(str(manifest["source_run"])).resolve()
        if not _separate_directories(run_dir, source_run):
            raise ValueError("Reuse output must be separate from the source run")
        run_dir.mkdir(parents=True, exist_ok=True)
        for relative in manifest["files"]:
            source = bundle_dir / relative
            destination = run_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        _verify_reuse_bundle(bundle_dir, bundle_sha256)
        copied = {path.relative_to(run_dir).as_posix(): sha256_file(path) for path in _reuse_files(run_dir)}
        if copied != manifest["files"]:
            raise ValueError("Copied reuse artifact SHA-256 mismatch")
        relocate_selected_images(run_dir)
    provenance: dict[str, object] = {
        "mode": "single_stage_reuse",
        "stage": stage,
        "source_run": str(source_run),
        "bundle": str(bundle_dir),
        "manifest_sha256": bundle_sha256,
    }
    training_seed = 42
    if stage == "training":
        settings = json.loads((run_dir / "input_manifest.json").read_text(encoding="utf-8")).get("settings", {})
        training_seed = int(settings.get("seed", 42))
        provenance["training_seed"] = training_seed
    _write_json(run_dir / "reuse_provenance.json", provenance)
    _write_json(run_dir / "config.json", config.to_dict())
    _write_json(run_dir / "environment.json", _environment(root))
    logs = run_dir / "logs"
    stages = StageStore(run_dir / "stages")
    with _timed(timings, stage), stages.running(stage, stage=stage, reuse_manifest_sha256=bundle_sha256):
        if stage == "training":
            _ensure_downsampled_images(run_dir, config.gsplat_data_factor)
            run_command(
                gsplat_command(root, run_dir, run_dir / "gsplat", config, seed=training_seed),
                logs / "training.log",
                cwd=root,
            )
        else:
            run_command(
                [
                    sys.executable,
                    "-m",
                    "rescene.colmap_runner",
                    "--scene-dir",
                    str(run_dir),
                    "--dense-only",
                    "--mvs-max-image-size",
                    str(config.colmap_mvs_max_image_size),
                    "--poisson-depth",
                    str(config.colmap_poisson_depth),
                    *(
                        ["--mvs-iterations", str(config.colmap_mvs_iterations)]
                        if config.colmap_mvs_iterations is not None
                        else []
                    ),
                ],
                logs / "dense.log",
                cwd=root,
            )
    metrics = collect_metrics(run_dir)
    metrics["total_seconds"] = None
    metrics["reuse"] = provenance
    metrics["timings"] = timings
    _write_json(run_dir / "metrics.json", metrics)
    write_report(run_dir, metrics)
    return run_dir


def run_pipeline(
    profile: str,
    input_path: Path,
    run_id: str,
    *,
    resume: bool = False,
    frame_limit: int | None = None,
    config_override: ProfileConfig | None = None,
    metadata: dict[str, object] | None = None,
    output_dir: Path | None = None,
    record_hashes: bool = False,
    diagnostics: bool = False,
    validation_sources: set[str] | None = None,
    reuse_bundle: Path | None = None,
    reuse_sha256: str | None = None,
    reuse_stage: str | None = None,
    random_seed: int | None = None,
    matching_db: Path | None = None,
    selected_sources: set[str] | None = None,
    retain_frozen_sources: bool = False,
) -> Path:
    root = project_root()
    run_dir = (output_dir if output_dir else root / "runs" / run_id).resolve()
    if any(value is not None for value in (reuse_bundle, reuse_sha256, reuse_stage)):
        if reuse_bundle is None or reuse_sha256 is None or reuse_stage is None or resume:
            raise ValueError("Reuse requires a bundle, its SHA-256, a stage, and a fresh run (no resume)")
        config = config_override or profile_config(profile)
        if config.name.value != profile:
            raise ValueError(f"Profile override is for {config.name.value}, not {profile}")
        if retain_frozen_sources or any(
            value is not None for value in (frame_limit, validation_sources, random_seed, matching_db, selected_sources)
        ):
            raise ValueError("Reuse comparisons use the bundle's fixed image selection")
        return _run_reuse_comparison(root, run_dir, config, reuse_bundle, reuse_sha256, reuse_stage)
    if _run_dir_has_results(run_dir) and not resume:
        raise FileExistsError(f"Run already exists; use --resume: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=True)
    logs = run_dir / "logs"
    logs.mkdir(exist_ok=True)
    stages = StageStore(run_dir / "stages")
    config = config_override or profile_config(profile)
    if config.name.value != profile:
        raise ValueError(f"Profile override is for {config.name.value}, not {profile}")
    if frame_limit is not None:
        config = replace(config, max_frames=min(config.max_frames, frame_limit))
    _write_json(run_dir / "config.json", config.to_dict())
    if metadata is not None:
        _write_json(run_dir / "benchmark.json", metadata)
    _write_json(run_dir / "environment.json", _environment(root))

    manifest_path = run_dir / "input_manifest.json"
    timings: dict[str, float] = {}
    if (
        resume
        and stages.read("preprocess").get("status") == "success"
        and not stages.complete(
            "preprocess", [manifest_path, run_dir / "images", run_dir / "photometric_selection.json"]
        )
    ):
        raise ValueError("Cannot resume: successful preprocess lacks required selection artifacts; start a new run")
    if not (
        resume
        and stages.complete("preprocess", [manifest_path, run_dir / "images", run_dir / "photometric_selection.json"])
    ):
        with (
            _timed(timings, "preprocess"),
            stages.running("preprocess", stage="preprocess", max_frames=config.max_frames),
        ):
            preprocess_input(
                input_path,
                run_dir,
                scene=run_id,
                max_frames=config.max_frames,
                max_side=config.preprocess_max_side,
                record_hashes=record_hashes,
                validation_sources=validation_sources,
                retain_frozen_sources=retain_frozen_sources,
                seed=42 if random_seed is None else random_seed,
            )
    seed = 42
    if manifest_path.is_file():
        seed = int(json.loads(manifest_path.read_text(encoding="utf-8")).get("settings", {}).get("seed", 42))
    if random_seed is not None and seed != random_seed:
        raise ValueError("Cannot resume with a different random seed")
    if selected_sources is not None:
        selection = json.loads((run_dir / "photometric_selection.json").read_text(encoding="utf-8"))
        if set(selection["train_source_ids"] + selection["validation_source_ids"]) != selected_sources:
            raise ValueError("Actual selected sources differ from the frozen selection")
    if matching_db is not None and config.geometry_backend != "colmap":
        raise ValueError("A matching database requires the COLMAP route")

    sparse_outputs = [run_dir / "sparse"]
    degradation_path = run_dir / "degradation.json"
    degraded: dict[str, object] | None = (
        json.loads(degradation_path.read_text(encoding="utf-8")) if resume and degradation_path.is_file() else None
    )
    if not (resume and stages.complete("geometry", sparse_outputs)):
        geometry_log = logs / "geometry.log"
        with _timed(timings, "geometry"), stages.running("geometry", stage="geometry", backend=config.geometry_backend):
            sequential = classify_input(input_path) == "video"
            geometry_config = config
            command = (
                vggt_command(root, run_dir, geometry_config, seed=seed, diagnostics=diagnostics)
                if config.geometry_backend == "vggt"
                else colmap_command(
                    run_dir,
                    sequential=sequential,
                    dense=config.dense_reconstruction,
                    camera_model=config.colmap_camera_model,
                    mvs_max_image_size=config.colmap_mvs_max_image_size,
                    poisson_depth=config.colmap_poisson_depth,
                    mapper=config.colmap_mapper,
                    matching_db=matching_db,
                    seed=random_seed,
                    shared_camera=config.colmap_shared_camera,
                    mvs_iterations=config.colmap_mvs_iterations,
                    sparse_threads=config.colmap_sparse_threads,
                )
            )
            try:
                run_command(command, geometry_log, cwd=root)
            except Exception as error:
                if (
                    config.colmap_mapper != "incremental"
                    or matching_db is not None
                    or config.colmap_shared_camera
                    or config.colmap_mvs_iterations is not None
                ):
                    raise
                if config.geometry_backend == "colmap":
                    fallback = {**config.to_dict(), "matcher": "sequential" if not sequential else "exhaustive"}
                    degraded = {"stage": "geometry", "reason": "matcher_retry", "config": fallback}
                    _write_json(run_dir / "degradation.json", degraded)
                    _clear_colmap_outputs(run_dir)
                    with _timed(timings, "fallback_geometry"):
                        run_command(
                            colmap_command(
                                run_dir,
                                sequential=not sequential,
                                dense=config.dense_reconstruction,
                                camera_model=config.colmap_camera_model,
                                mvs_max_image_size=config.colmap_mvs_max_image_size,
                                poisson_depth=config.colmap_poisson_depth,
                                seed=random_seed,
                                sparse_threads=config.colmap_sparse_threads,
                            ),
                            geometry_log,
                            cwd=root,
                        )
                elif config.geometry_backend == "vggt" and is_vggt_ba_failure(error, geometry_log):
                    fallback = replace(
                        config,
                        vggt_query_frames=min(16, config.max_frames),
                        vggt_max_query_points=max(2_048, config.vggt_max_query_points),
                    )
                    shutil.rmtree(run_dir / "sparse", ignore_errors=True)
                    recovered = False
                    if fallback != config:
                        degraded = {"stage": "geometry", "reason": "ba_failed", "config": fallback.to_dict()}
                        _write_json(run_dir / "degradation.json", degraded)
                        retry_log = logs / "geometry-retry.log"
                        retry_log.unlink(missing_ok=True)
                        try:
                            run_command(
                                vggt_command(root, run_dir, fallback, seed=seed, diagnostics=diagnostics),
                                retry_log,
                                cwd=root,
                            )
                            recovered = True
                        except Exception as fallback_error:
                            if not is_vggt_ba_failure(fallback_error, retry_log):
                                raise
                    if not recovered:
                        degraded = {
                            "stage": "geometry",
                            "reason": "ba_failed+colmap_sparse",
                            "config": {
                                **config.to_dict(),
                                "geometry_backend": "colmap",
                                "dense_reconstruction": False,
                            },
                        }
                        _write_json(run_dir / "degradation.json", degraded)
                        _run_sparse_colmap(
                            root,
                            run_dir,
                            geometry_log,
                            sequential=sequential,
                            camera_model=config.colmap_camera_model,
                            mvs_max_image_size=config.colmap_mvs_max_image_size,
                            poisson_depth=config.colmap_poisson_depth,
                        )
                    geometry_config = fallback
                elif config.geometry_backend != "vggt" or not is_cuda_oom(error, geometry_log):
                    raise
                else:
                    fallback = config.degraded()
                    degraded = {"stage": "geometry", "reason": "cuda_oom", "config": fallback.to_dict()}
                    _write_json(run_dir / "degradation.json", degraded)
                    shutil.rmtree(run_dir / "sparse", ignore_errors=True)
                    preprocess_input(
                        input_path,
                        run_dir,
                        scene=run_id,
                        max_frames=fallback.max_frames,
                        max_side=fallback.preprocess_max_side,
                        record_hashes=record_hashes,
                        validation_sources=validation_sources,
                    )
                    run_command(
                        vggt_command(root, run_dir, fallback, seed=seed, diagnostics=diagnostics),
                        geometry_log,
                        cwd=root,
                    )
                    geometry_config = fallback
            if not _sparse_has_points(run_dir):
                if geometry_config.name.value != "fast" or geometry_config.use_bundle_adjustment:
                    raise RuntimeError("Geometry completed without sparse 3D points")
                fallback = replace(
                    geometry_config,
                    use_bundle_adjustment=True,
                    vggt_query_frames=min(16, geometry_config.max_frames),
                    vggt_max_query_points=max(2_048, geometry_config.vggt_max_query_points),
                )
                previous = f"{degraded['reason']}+" if degraded else ""
                degraded = {
                    "stage": "geometry",
                    "reason": f"{previous}empty_sparse",
                    "config": fallback.to_dict(),
                }
                _write_json(run_dir / "degradation.json", degraded)
                shutil.rmtree(run_dir / "sparse", ignore_errors=True)
                try:
                    run_command(
                        vggt_command(root, run_dir, fallback, seed=seed, diagnostics=diagnostics),
                        geometry_log,
                        cwd=root,
                    )
                except Exception as fallback_error:
                    if not is_vggt_ba_failure(fallback_error, geometry_log):
                        raise
                    degraded = {
                        "stage": "geometry",
                        "reason": f"{previous}empty_sparse+ba_failed+colmap_sparse",
                        "config": {
                            **config.to_dict(),
                            "geometry_backend": "colmap",
                            "dense_reconstruction": False,
                        },
                    }
                    _write_json(run_dir / "degradation.json", degraded)
                    _run_sparse_colmap(
                        root,
                        run_dir,
                        geometry_log,
                        sequential=sequential,
                        camera_model=config.colmap_camera_model,
                        mvs_max_image_size=config.colmap_mvs_max_image_size,
                        poisson_depth=config.colmap_poisson_depth,
                    )
                if not _sparse_has_points(run_dir):
                    raise RuntimeError("VGGT BA fallback completed without sparse 3D points")

    gsplat_dir = run_dir / "gsplat"
    training_outputs = [
        gsplat_dir,
        run_dir / "photometric_split.json",
        gsplat_dir / "photometric_views.json",
        gsplat_dir / "run.json",
        run_dir / "geometry_frames.json",
    ]
    if (
        resume
        and stages.read("training").get("status") == "success"
        and not stages.complete("training", training_outputs)
    ):
        raise ValueError("Cannot resume: successful training lacks required provenance; start a new run")
    if not (resume and stages.complete("training", training_outputs)):
        training_log = logs / "training.log"
        with _timed(timings, "training"), stages.running("training", stage="training", steps=config.gsplat_steps):
            _ensure_downsampled_images(run_dir, config.gsplat_data_factor)
            try:
                run_command(gsplat_command(root, run_dir, gsplat_dir, config, seed=seed), training_log, cwd=root)
            except Exception as error:
                if not is_cuda_oom(error, training_log):
                    raise
                fallback = config.degraded()
                degraded = {"stage": "training", "reason": "cuda_oom", "config": fallback.to_dict()}
                _write_json(run_dir / "degradation.json", degraded)
                shutil.rmtree(gsplat_dir, ignore_errors=True)
                _ensure_downsampled_images(run_dir, fallback.gsplat_data_factor)
                with _timed(timings, "fallback_training"):
                    run_command(gsplat_command(root, run_dir, gsplat_dir, fallback, seed=seed), training_log, cwd=root)

    spz_path = run_dir / "scene.spz"
    if not (resume and stages.complete("export", [spz_path])):
        with _timed(timings, "export"), stages.running("export", stage="export"):
            run_command(
                [sys.executable, "-m", "rescene.spz_runner", str(_find_ply(run_dir)), str(spz_path)],
                logs / "export.log",
                cwd=root,
            )

    with _timed(timings, "evaluation"):
        metrics = collect_metrics(run_dir, degraded)
    metrics["timings"] = dict(timings)
    _write_json(run_dir / "metrics.json", metrics)
    write_report(run_dir, metrics)
    return run_dir


def report_run(run_id: str) -> Path:
    run_dir = project_root() / "runs" / run_id
    if not run_dir.exists():
        raise FileNotFoundError(f"Run not found: {run_dir}")
    degradation_path = run_dir / "degradation.json"
    degradation = json.loads(degradation_path.read_text(encoding="utf-8")) if degradation_path.exists() else None
    metrics = collect_metrics(run_dir, degradation)
    metrics_path = run_dir / "metrics.json"
    if metrics_path.is_file():
        try:
            previous = json.loads(metrics_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = None
        if isinstance(previous, dict):
            if isinstance(previous.get("timings"), dict):
                metrics["timings"] = previous["timings"]
            merge_evaluation_evidence(metrics, previous, run_dir)
    reuse_path = run_dir / "reuse_provenance.json"
    if reuse_path.is_file():
        metrics["reuse"] = json.loads(reuse_path.read_text(encoding="utf-8"))
        metrics["total_seconds"] = None
    _write_json(metrics_path, metrics)
    return write_report(run_dir, metrics)
