"""Run the quality-first DSLR study with the frozen-trial supervisor."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

if __package__:
    from . import supervise_route_experiments as supervisor
    from .freeze_manyview import evenly_spaced
    from .route_experiments_v3 import atomic_json
else:
    import supervise_route_experiments as supervisor
    from freeze_manyview import evenly_spaced
    from route_experiments_v3 import atomic_json

from rescene.evaluation import _official_point_scores, evaluate_run
from rescene.geometry_metrics import _normalized_error, _observed_points, _read_model
from rescene.pipeline import create_reuse_bundle
from rescene.preprocess import discover_images, preprocess_input, sha256_file

SCENES = {"office": 26, "courtyard": 38, "kicker": 31, "terrace": 23}
PROFILES = ("fast", "balanced", "quality")
CANDIDATES = {
    "fast": {"vggt_grid_sampling": True},
    "balanced": {"vggt_query_coverage": True},
    "quality": {"colmap_shared_camera": True, "colmap_camera_model": "PINHOLE"},
}
SPEED = {"fast": {"gsplat_steps": 6000}, "balanced": {"gsplat_steps": 16000}, "quality": {"colmap_mvs_iterations": 3}}
SCORE_FIELDS = (
    "point_fscore",
    "point_accuracy",
    "point_completeness",
    "point_threshold",
    "pose_ate",
    "pose_rotation_error",
    "evaluation_registered_images",
    "evaluation_artifact_to_reference",
    "official_evaluator_sha256",
)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def verify_archive(directory: Path) -> None:
    manifest = directory / "archive.json"
    if manifest.is_file() and any(
        sha256_file(directory / relative) != digest for relative, digest in read_json(manifest)["sha256"].items()
    ):
        raise ValueError(f"Trial archive failed SHA-256 verification: {directory}")


def study_input(dataset: Path, scene: str, work: Path) -> Path:
    if scene in ("office", "courtyard"):
        cached = supervisor.ROOT / "data" / f"eth3d-{scene}"
        if all(
            (cached / name).is_dir()
            for name in ("dslr_images_undistorted", "dslr_calibration_undistorted", "dslr_scan_eval")
        ):
            return cached
    source = work / "data" / scene
    if (source / ".complete").exists():
        return source
    subprocess.run(["sha256sum", "-c", "checksums.sha256"], cwd=dataset, check=True, timeout=900)
    source.mkdir(parents=True, exist_ok=True)
    for name in ("dslr_undistorted", "dslr_scan_eval"):
        subprocess.run(
            ["7z", "x", "-aos", "-bd", "-bso0", "-mmt=4", f"-o{source.parent}", str(dataset / f"{scene}_{name}.7z")],
            check=True,
            timeout=900,
        )
    images = source / "dslr_images_undistorted"
    if not images.is_dir():
        (source / "images" / images.name).rename(images)
    if not (source / "dslr_calibration_undistorted").is_dir() or not (source / "dslr_scan_eval").is_dir():
        raise ValueError(f"Incomplete official ETH3D archives for {scene}")
    (source / ".complete").touch()
    return source


def freeze_scene(directory: Path, scene: str, archive: Path) -> dict:
    images = directory / "dslr_images_undistorted"
    sources = discover_images(images)
    names = [path.name for path in sources]
    if len(names) != SCENES[scene]:
        raise ValueError(f"{scene}: expected {SCENES[scene]} images, found {len(names)}")
    held_out = set(evenly_spaced(names, 8))
    record = {
        "scene": str(images.resolve()),
        "scene_id": scene,
        "dataset": "eth3d-dslr-quality-v1",
        "frame_limit": len(names),
        "selected_sources": names,
        "source_sha256": {path.name: sha256_file(path) for path in sources},
        "validation": {"sources": [index for index, name in enumerate(names) if name in held_out]},
        "retain_frozen_sources": True,
        "allow_missing_validation": True,
        "diagnostics": True,
        "keep_artifacts": True,
    }
    manifest = archive / f"{scene}-frozen.json"
    if manifest.is_file() and read_json(manifest) != record:
        raise ValueError(f"{scene}: frozen source provenance changed")
    atomic_json(manifest, record)
    return record


def reference_model(truth: Path, prepared: Path, manifest: dict) -> bool:
    import pycolmap
    from PIL import Image

    model = pycolmap.Reconstruction(truth)
    frames = {f"dslr_images_undistorted/{row['source_id']}": row for row in manifest["frames"]}
    if set(frames) != {image.name for image in model.images.values()}:
        raise ValueError("Official camera names differ from the frozen images")
    dimensions: dict[int, tuple[int, int]] = {}
    for image in model.images.values():
        row = frames[image.name]
        with Image.open(row["source"]) as original:
            if original.getexif().get(274, 1) != 1 or original.size != (image.camera.width, image.camera.height):
                raise ValueError(f"Calibration does not match stored pixel coordinates: {image.name}")
        size = (row["width"], row["height"])
        if dimensions.setdefault(image.camera_id, size) != size:
            raise ValueError("Images with a shared reference camera resized to different dimensions")
        scale = (size[0] / image.camera.width, size[1] / image.camera.height)
        for observation in image.points2D:
            observation.xy = observation.xy * scale
        image.name = Path(row["file"]).name
    for camera_id, size in dimensions.items():
        model.cameras[camera_id].rescale(*size)
    sparse = prepared / "sparse" / "0"
    sparse.mkdir(parents=True)
    model.write(sparse)
    return len(dimensions) == 1


def reference(directory: Path, specification: dict, work: Path, archive: Path, evaluator: Path, deadline: int) -> dict:
    scene = specification["scene_id"]
    evidence = archive / f"{scene}-reference"
    if (evidence / "result.json").exists():
        return read_json(evidence / "result.json")
    if supervisor.free_bytes() < 10 * 1024**3:
        raise RuntimeError("Reference MVS requires 10 GiB free before staging")
    if supervisor.gpu_processes():
        raise RuntimeError("A compute process appeared before reference MVS")
    evidence.mkdir(exist_ok=True)
    prepared = work / f"{scene}-reference"
    selected = specification["selected_sources"]
    held_out = {selected[index] for index in specification["validation"]["sources"]}
    manifest = preprocess_input(
        Path(specification["scene"]),
        prepared,
        scene=scene,
        max_frames=len(selected),
        validation_sources=held_out,
        retain_frozen_sources=True,
        record_hashes=True,
    )
    try:
        single = reference_model(directory / "dslr_calibration_undistorted", prepared, manifest)
        cloud = prepared / "dense" / "fused.ply"
        with (evidence / "mvs.log").open("wb") as log:
            run_dense(prepared, log, deadline)
        accuracy, completeness, fscore = _official_point_scores(
            evaluator, cloud, directory / "dslr_scan_eval" / "scan_alignment.mlp", 0.02, evidence / "eth3d.log"
        )
        result = {
            "single_camera": single,
            "point_fscore": fscore,
            "point_accuracy": accuracy,
            "point_completeness": completeness,
            "point_threshold": 0.02,
            "cloud_sha256": sha256_file(cloud),
        }
        shutil.copy2(prepared / "colmap-phases.json", evidence)
        atomic_json(evidence / "result.json", result)
        return result
    finally:
        shutil.rmtree(prepared)


def run_dense(prepared: Path, log, deadline: int, iterations: int | None = None) -> None:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "rescene.colmap_runner",
            "--scene-dir",
            str(prepared),
            "--dense-only",
            *(["--mvs-iterations", str(iterations)] if iterations is not None else []),
        ],
        check=True,
        env=supervisor.environment(),
        stdout=log,
        stderr=subprocess.STDOUT,
        timeout=max(1, min(2100, deadline - time.time())),
    )


def pair_quality(base: dict, candidate: dict, profile: str, *, strict: bool) -> list[str]:
    """Return concrete quality failures on the intersection of supported views."""
    if not base.get("valid") or not candidate.get("valid"):
        return ["baseline_unusable" if not base.get("valid") else "candidate_unusable"]
    common = set(base["supported"]) & set(candidate["supported"])
    if len(common) < (8 if strict else 7):
        return ["validation_coverage"]
    failures = []
    for key, sign, limit in (("psnr", -1, 0.20), ("ssim", -1, 0.01), ("lpips", 1, 0.01)):
        delta = statistics.mean(sign * (candidate["views"][view][key] - base["views"][view][key]) for view in common)
        if delta > limit + 1e-10:
            failures.append(key)
    if any(
        tuple(base["views"][view][key] for key in ("scoring_width", "scoring_height"))
        != tuple(candidate["views"][view][key] for key in ("scoring_width", "scoring_height"))
        for view in common
    ):
        failures.append("photometric_dimensions")
    if candidate["registration_rate"] < base["registration_rate"] - 0.01 - 1e-10:
        failures.append("registration")
    if candidate["peak_mib"] > candidate["gpu_total_mib"] - 3072:
        failures.append("gpu_headroom")
    if profile == "balanced":
        comparison = common_ba_observations(base, candidate)
        if not comparison["count"] or comparison["mean_increase_px"] > 0.10 + 1e-10:
            failures.append("ba_error")
    if profile == "quality":
        f1 = candidate.get("point_fscore")
        baseline_f1 = base.get("point_fscore")
        if f1 is None or baseline_f1 is None or baseline_f1 <= 0 or f1 <= 0 or f1 < baseline_f1 * 0.95:
            failures.append("dense_f1")
    return failures


def common_ba_observations(base: dict, candidate: dict) -> dict:
    """Compare post-BA observations with mutual pixel proximity in the same image."""
    import numpy as np
    from scipy.spatial import cKDTree

    paths = [
        Path(row["sparse"])
        if row.get("sparse")
        else Path(row["reuse_bundle"]) / "sparse"
        if row.get("reuse_bundle")
        else None
        for row in (base, candidate)
    ]
    if any(path is None or not path.is_dir() for path in paths):
        return {"count": 0, "mean_increase_px": None}
    models = [_read_model(path / "0" if (path / "0").is_dir() else path) for path in paths]
    observations = []
    focal_lengths = []
    for model in models:
        grouped: dict[str, list] = {}
        for (image_id, point_id), point in _observed_points(model).items():
            image = model.images[image_id]
            error = _normalized_error(model, image, point_id, point)
            if error is not None:
                grouped.setdefault(image.name, []).append((point, error))
        focal_lengths.extend(float(camera.mean_focal_length()) for camera in model.cameras.values())
        observations.append(grouped)
    changes = []
    for name in sorted(observations[0].keys() & observations[1].keys()):
        pairs = [table[name] for table in observations]
        points = [np.array([xy for xy, _ in row]) for row in pairs]
        distance, right = cKDTree(points[1]).query(points[0])
        _, left = cKDTree(points[0]).query(points[1])
        changes.extend(
            pairs[1][name_index][1] - pairs[0][index][1]
            for index, name_index in enumerate(right)
            if distance[index] <= 1.0 and left[name_index] == index
        )
    return {
        "count": len(changes),
        "mean_increase_px": statistics.mean(changes) * statistics.median(focal_lengths) if changes else None,
    }


def save_run_evidence(run: Path, archive: Path, result: dict) -> None:
    archive.mkdir(parents=True, exist_ok=True)
    evidence = archive / "study-result.json"
    atomic_json(evidence, result)
    if not (archive / "archive.json").exists():
        for path in [*run.glob("*.json"), *(run / "logs").glob("*.log")]:
            shutil.copy2(path, archive / path.name)
    log = supervisor.RUNS / "logs" / f"{run.name}.log"
    if log.is_file():
        shutil.copy2(log, archive / "supervisor.log")
    if (run / "evaluation" / "eth3d-official.log").exists():
        shutil.copy2(run / "evaluation" / "eth3d-official.log", archive)


def prepare() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--evaluator", type=Path, required=True)
    parser.add_argument("--deadline", type=int, required=True)
    parser.add_argument("--baselines-only", action="store_true")
    parser.add_argument("--recovery-cold-only", action="store_true")
    parser.add_argument("--rescreen", choices=PROFILES)
    return parser.parse_args()


class Study:
    def __init__(self, args: argparse.Namespace) -> None:
        self.dataset = args.dataset
        self.archive = args.archive
        self.work = supervisor.RUNS
        self.evaluator = args.evaluator
        self.deadline = args.deadline
        gpu_total = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], text=True, timeout=10
        )
        self.gpu_total = int(gpu_total.strip())
        self.specifications: dict[str, dict] = {}
        self.references: dict[str, dict] = {}
        self.directory: dict[str, Path] = {}
        self.archive.mkdir(parents=True, exist_ok=True)
        for folder in (self.archive / "plans", self.work / "runs", self.work / "resources"):
            folder.mkdir(parents=True, exist_ok=True)
        self.lock = self.archive / "environment-lock.json"
        if not self.lock.is_file():
            from rescene.pipeline import _environment

            atomic_json(self.lock, _environment(supervisor.SOURCE))

    def setup(self, scene: str) -> None:
        # Keep the official compressed and decoded reference inputs on the mounted
        # archive so that each trial has local space for normalized images and MVS.
        directory = study_input(self.dataset, scene, self.archive / "staging")
        self.directory[scene] = directory
        specification = freeze_scene(directory, scene, self.archive)
        self.specifications[scene] = specification
        try:
            result = reference(directory, specification, self.work, self.archive, self.evaluator, self.deadline)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            result = {"error": f"{type(error).__name__}: {error}"}
            atomic_json(self.archive / f"{scene}-reference-error.json", result)
        self.references[scene] = result
        supervisor.emit(f"REFERENCE {scene} {json.dumps(result)}")

    def finish_run(self, run: Path, resource: dict, scene: str, profile: str, dest: Path) -> dict:
        result = {
            "valid": resource["valid"],
            "reason": resource.get("trial_failure") or resource.get("abort_reason"),
            "peak_mib": resource["peak_owned_gpu_mib_sampled"],
            "gpu_total_mib": self.gpu_total,
            "wall_seconds": resource["wall_seconds"],
            "resources": resource,
        }
        if (run / "metrics.json").is_file():
            metrics = read_json(run / "metrics.json")
            result.update(
                {
                    key: metrics.get(key)
                    for key in (
                        "psnr",
                        "ssim",
                        "lpips",
                        "registration_rate",
                        "total_seconds",
                        "training_seconds",
                        "degraded",
                        "registered_images",
                        "gaussian_count",
                        "validation_registered",
                        "reprojection_error",
                    )
                }
            )
            result["views"] = {view["source_id"]: view for view in metrics.get("photometric_views", [])}
            result["supported"] = sorted(set(metrics["validation_registered_frames"]) & set(result["views"]))
        if (run / "geometry-ba.json").is_file():
            ba = read_json(run / "geometry-ba.json")
            result["ba_after_px"] = ba["after"]["mean"]
            result["ba_common_observations"] = ba["common_observations"]
        if (run / "vggt-phases.json").is_file():
            result["vggt_phases"] = read_json(run / "vggt-phases.json")
        if (run / "colmap-phases.json").is_file():
            result["colmap_phases"] = read_json(run / "colmap-phases.json")
        model = run / "sparse"
        model = model / "0" if (model / "0").is_dir() else model
        selection = run / "photometric_selection.json"
        if selection.is_file() and all(
            (model / name).is_file() for name in ("cameras.bin", "images.bin", "points3D.bin")
        ):
            sources = read_json(selection)["image_to_source_id"]
            result["sparse_points_by_source"] = {
                sources[image.name]: image.num_points3D
                for image in _read_model(model).images.values()
                if image.name in sources
            }
        if result["valid"]:
            directory = self.directory[scene]
            try:
                metrics = evaluate_run(
                    run,
                    directory / "dslr_calibration_undistorted",
                    directory / "dslr_scan_eval" / "scan_alignment.mlp" if profile == "quality" else None,
                    official_evaluator=self.evaluator,
                    reference_image_prefix="dslr_images_undistorted/",
                    persist=False,
                )
                result.update({key: metrics[key] for key in SCORE_FIELDS if key in metrics})
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                result.update(valid=False, reason=f"evaluation: {error}")
        dest.mkdir(exist_ok=True)
        if profile == "balanced" and result["valid"]:
            sparse = dest / "sparse"
            shutil.copytree(model, sparse)
            result["sparse"] = str(sparse)
            result["sparse_hashes"] = {path.name: sha256_file(path) for path in sparse.iterdir() if path.is_file()}
        if (run / "dense" / "fused.ply").is_file():
            target = dest / "fused.ply"
            shutil.copy2(run / "dense" / "fused.ply", target)
            result["dense_sha256"] = sha256_file(target)
            if result["dense_sha256"] != sha256_file(run / "dense" / "fused.ply"):
                raise ValueError("Dense artifact SHA-256 mismatch")
        save_run_evidence(run, dest, result)
        return result

    def trial(self, scene: str, profile: str, label: str, overrides: dict, seed: int = 42, *, keep_reuse=False) -> dict:
        name = f"{scene}-{profile}-{label}-s{seed}"
        dest = self.archive / name
        if (dest / "study-result.json").is_file():
            verify_archive(dest)
            return read_json(dest / "study-result.json")
        if supervisor.gpu_processes():
            raise RuntimeError("A compute process appeared before the next isolated trial")
        if profile == "quality" and not self.references[scene].get("point_fscore", 0) > 0:
            return {"valid": False, "reason": "reference_f1_unverified"}
        if overrides.get("colmap_shared_camera") and not self.references[scene].get("single_camera"):
            return {"valid": False, "reason": "single_camera_eligibility"}
        spec = {
            **self.specifications[scene],
            "profile": profile,
            "candidate_id": name,
            "seed": seed,
            "overrides": overrides,
            "environment_lock": str(self.lock),
            "environment_lock_sha256": sha256_file(self.lock),
        }
        if overrides.get("colmap_shared_camera"):
            spec["capture"] = "eth3d-dslr-single-camera"
        spec_path = self.archive / "plans" / f"{name}.json"
        atomic_json(spec_path, spec)
        trial = {
            "name": name,
            "profile": profile,
            "repeat": seed - 41,
            "spec": str(spec_path),
            "expected_write_bytes": 5 * 1024**3,
            "wall_estimate_seconds": {"fast": 600, "balanced": 1100, "quality": 2300}[profile],
        }
        requirement = supervisor.trial_requirement(trial, self.deadline, supervisor.free_bytes(), time.time())
        if requirement:
            return {"valid": False, "reason": requirement}
        run = self.work / "runs" / name
        resource = supervisor.monitor(trial, self.deadline)
        result = self.finish_run(run, resource, scene, profile, dest)
        if keep_reuse and result["valid"] and len(result["supported"]) == 8:
            bundle = self.archive / "reuse" / name
            result["reuse_sha256"] = create_reuse_bundle(run, bundle)
            result["reuse_bundle"] = str(bundle)
            atomic_json(dest / "study-result.json", result)
        if run.is_dir():
            shutil.rmtree(run)
        supervisor.emit(
            f"RESULT {name} {json.dumps({key: result.get(key) for key in ('valid', 'reason', 'psnr', 'point_fscore', 'total_seconds')})}"
        )
        if resource.get("abort_reason") and resource.get("trial_failure") != "trial_timeout":
            raise RuntimeError(resource["abort_reason"])
        return result

    def stage_probe(self, scene: str, profile: str, source: dict, overrides: dict) -> dict:
        """Measure both settings from the same verified sparse bundle."""
        if not source.get("reuse_bundle"):
            return {"valid": False, "reason": "fixed_sparse_unavailable"}
        stage = "dense" if profile == "quality" else "training"
        evidence = self.archive / f"{scene}-{profile}-{stage}-probe"
        evidence.mkdir(exist_ok=True)
        if (evidence / "result.json").is_file():
            return read_json(evidence / "result.json")
        results = {}
        for label, changes in (("control", overrides), ("candidate", {**overrides, **SPEED[profile]})):
            run = self.work / f"{scene}-{profile}-{stage}-{label}"
            if self.deadline - time.time() < (2000 if stage == "dense" else 950):
                return {"valid": False, "reason": "insufficient_time"}
            if supervisor.free_bytes() < 10 * 1024**3:
                return {"valid": False, "reason": "insufficient_disk"}
            if supervisor.gpu_processes():
                raise RuntimeError("A compute process appeared before the stage probe")
            script = (
                "import json,sys; from pathlib import Path; from rescene.config import profile_config; "
                "from rescene.pipeline import run_pipeline; p,r,b,h,s,o=sys.argv[1:]; "
                "run_pipeline(p,Path(b),Path(r).name,output_dir=Path(r),"
                "config_override=profile_config(p).with_overrides(json.loads(o)),"
                "reuse_bundle=Path(b),reuse_sha256=h,reuse_stage=s)"
            )
            try:
                with (evidence / f"{label}.log").open("wb") as log:
                    process = subprocess.Popen(
                        [
                            sys.executable,
                            "-c",
                            script,
                            profile,
                            str(run),
                            source["reuse_bundle"],
                            source["reuse_sha256"],
                            stage,
                            json.dumps(changes),
                        ],
                        env=supervisor.environment(),
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    try:
                        exit_code = process.wait(timeout=max(1, min(2200, self.deadline - time.time())))
                    finally:
                        if process.poll() is None:
                            os.killpg(process.pid, signal.SIGTERM)
                            try:
                                process.wait(timeout=30)
                            except subprocess.TimeoutExpired:
                                os.killpg(process.pid, signal.SIGKILL)
                                process.wait(timeout=15)
                    if exit_code:
                        raise RuntimeError(f"{stage} probe exited {exit_code}; see {evidence / f'{label}.log'}")
                metrics = read_json(run / "metrics.json")
                for path in (run / "logs").glob("*.log"):
                    shutil.copy2(path, evidence / f"{label}-{path.name}")
                if stage == "dense":
                    directory = self.directory[scene]
                    manifest = read_json(run / "photometric_selection.json")
                    atomic_json(run / "photometric_split.json", manifest)
                    identity = [[int(i == j) for j in range(4)] for i in range(4)]
                    atomic_json(
                        run / "geometry_frames.json",
                        {
                            "colmap_to_trainer": identity,
                            "trainer_to_colmap": identity,
                            "artifacts": {"dense/fused.ply": "colmap"},
                        },
                    )
                    metrics = evaluate_run(
                        run,
                        directory / "dslr_calibration_undistorted",
                        directory / "dslr_scan_eval" / "scan_alignment.mlp",
                        official_evaluator=self.evaluator,
                        reference_image_prefix="dslr_images_undistorted/",
                        persist=False,
                    )
                    shutil.copy2(run / "evaluation" / "eth3d-official.log", evidence / f"{label}-eth3d.log")
                    metrics["colmap_phases"] = read_json(run / "colmap-phases.json")
                results[label] = metrics
                atomic_json(evidence / f"{label}.json", metrics)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                return {"valid": False, "reason": f"stage_probe: {error}"}
            finally:
                if run.is_dir():
                    shutil.rmtree(run)
        control, candidate = (results[key] for key in ("control", "candidate"))
        if stage == "dense":

            def duration(row: dict) -> float:
                return sum(row["colmap_phases"][key] for key in ("patchmatch_seconds", "fusion_seconds"))

            quality = control["point_fscore"] > 0 and candidate["point_fscore"] >= control["point_fscore"] * 0.95
        else:

            def duration(row: dict) -> float:
                return row["training_seconds"]

            quality = all(
                sign * (candidate[key] - control[key]) <= limit + 1e-10
                for key, sign, limit in (
                    ("psnr", -1, 0.2),
                    ("ssim", -1, 0.01),
                    ("lpips", 1, 0.01),
                )
            )
        ratio = duration(candidate) / duration(control)
        result = {
            "valid": quality and ratio < 1,
            "quality": quality,
            "ratio": ratio,
            "reuse_sha256": source["reuse_sha256"],
            "stage": stage,
            "seconds": {"control": duration(control), "candidate": duration(candidate)},
        }
        atomic_json(evidence / "result.json", result)
        supervisor.emit(f"STAGE_PROBE {scene} {profile} {json.dumps(result)}")
        return result

    def baselines(self) -> dict:
        result = {}
        for scene in ("office", "courtyard"):
            self.setup(scene)
            result[scene] = {name: self.trial(scene, name, "baseline", {}, keep_reuse=True) for name in PROFILES}
        return result

    def smoke(self) -> None:
        name = "golden-fast-smoke"
        scene = supervisor.ROOT / "data" / "golden-kitchen" / "images"
        spec = self.archive / "plans" / f"{name}.json"
        atomic_json(
            spec,
            {
                "scene": str(scene),
                "profile": "fast",
                "candidate_id": name,
                "seed": 42,
                "steps": 100,
                "validation": {"every": 8},
                "keep_artifacts": True,
            },
        )
        if (self.archive / name / "archive.json").is_file():
            verify_archive(self.archive / name)
            return
        result = supervisor.monitor({"name": name, "profile": "fast", "repeat": 1, "spec": str(spec)}, self.deadline)
        run = self.work / "runs" / name
        save_run_evidence(run, self.archive / name, result)
        if not result["valid"]:
            raise RuntimeError("Initial 100-step smoke failed")
        shutil.rmtree(run)

    def screen(self, baselines: dict, rescreen: str | None = None) -> dict:
        summary = self.archive / "screening-summary.json"
        screened = read_json(summary) if rescreen else {}
        for profile in (rescreen,) if rescreen else PROFILES:
            quality_label = "quality-rescreen" if rescreen else "quality"
            quality = {
                scene: self.trial(scene, profile, quality_label, CANDIDATES[profile], keep_reuse=True)
                for scene in baselines
            }
            checks = {
                scene: pair_quality(baselines[scene][profile], row, profile, strict=False)
                for scene, row in quality.items()
            }
            use_quality = not any(checks.values()) and all(len(row["supported"]) == 8 for row in quality.values())
            changes = CANDIDATES[profile] if use_quality else {}
            geometry = {scene: quality[scene] if use_quality else baselines[scene][profile] for scene in baselines}
            variants = {}
            if profile == "balanced":
                chunked = {**changes, "vggt_track_observation_limit": 65536}
                chunks = {scene: self.trial(scene, profile, "track64k", chunked) for scene in baselines}
                variants["track64k"] = {"overrides": chunked, "trials": chunks}
            probes = {}
            recovery = set()
            for scene, row in geometry.items():
                if not row.get("reuse_bundle") and quality[scene].get("reuse_bundle"):
                    probes[scene] = self.stage_probe(scene, profile, quality[scene], CANDIDATES[profile])
                    recovery.add(scene)
                else:
                    probes[scene] = self.stage_probe(scene, profile, row, changes)
            if not recovery and all(row["valid"] for row in probes.values()):
                speed = {**changes, **SPEED[profile]}
                runs = {scene: self.trial(scene, profile, "speed", speed) for scene in baselines}
                variants["speed"] = {"overrides": speed, "trials": runs}
            screened[profile] = {
                "quality": quality,
                "quality_checks": checks,
                "stage_probes": probes,
                "recovery_probes": sorted(recovery),
                "variants": variants,
            }
            atomic_json(summary, screened)
        return screened

    def confirm(self, baselines: dict, screened: dict) -> dict:
        result = {}
        for profile in reversed(PROFILES):
            result[profile] = {"promoted": False, "variants": {}}
            for label, variant in screened[profile]["variants"].items():
                first = variant["trials"]
                rows = {scene: [(baselines[scene][profile], candidate)] for scene, candidate in first.items()}
                initial_pairs = [pair[0] for pair in rows.values()]
                if any(
                    pair_quality(base, candidate, profile, strict=True) for base, candidate in initial_pairs
                ) or not any(speed_pass(base, candidate, profile) for base, candidate in initial_pairs):
                    result[profile]["variants"][label] = {"status": "screen_rejected"}
                    continue
                for seed in (43, 44):
                    for scene in rows:
                        if seed % 2:
                            candidate = self.trial(scene, profile, label, variant["overrides"], seed)
                            base = self.trial(scene, profile, "baseline", {}, seed)
                        else:
                            base = self.trial(scene, profile, "baseline", {}, seed)
                            candidate = self.trial(scene, profile, label, variant["overrides"], seed)
                        rows[scene].append((base, candidate))
                development = all(
                    all(not pair_quality(base, candidate, profile, strict=True) for base, candidate in pairs)
                    and median_speed_pass(pairs, profile)
                    for pairs in rows.values()
                )
                holdouts = {}
                if development:
                    atomic_json(self.archive / f"{profile}-frozen-candidate.json", variant["overrides"])
                    for scene in ("kicker", "terrace"):
                        try:
                            self.setup(scene)
                        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                            holdouts[scene] = {"valid": False, "reason": str(error)}
                            continue
                        base = self.trial(scene, profile, "baseline", {})
                        candidate = self.trial(scene, profile, label, variant["overrides"])
                        failures = pair_quality(base, candidate, profile, strict=True)
                        holdouts[scene] = {
                            "valid": not failures,
                            "failures": failures,
                            "baseline": base,
                            "candidate": candidate,
                        }
                        local = self.archive / "staging" / "data" / scene
                        if local == self.directory[scene].resolve() and local.is_dir():
                            shutil.rmtree(local)
                promoted = development and all(row["valid"] for row in holdouts.values()) and len(holdouts) == 2
                result[profile]["variants"][label] = {
                    "status": "qualified" if promoted else "confirmation_rejected",
                    "development": rows,
                    "holdouts": holdouts,
                    "overrides": variant["overrides"],
                }
                if promoted:
                    result[profile].update(promoted=True, approved_overrides=variant["overrides"])
                    break
                atomic_json(self.archive / "confirmation-summary.json", result)
            atomic_json(self.archive / "confirmation-summary.json", result)
        return result

    def recovery_cold(self, screened: dict) -> None:
        """Cold-start the faster recovered geometry without treating it as a production pair."""
        results = {}
        for profile, screen in screened.items():
            for scene in screen["recovery_probes"]:
                if not screen["stage_probes"][scene]["valid"]:
                    continue
                control = screen["quality"][scene]
                candidate = self.trial(scene, profile, "recovery-speed", {**CANDIDATES[profile], **SPEED[profile]})
                quality = pair_quality(control, candidate, profile, strict=True)
                results[f"{scene}-{profile}"] = {
                    "control": control,
                    "candidate": candidate,
                    "quality_failures": quality,
                    "meets_speed_target": not quality and speed_pass(control, candidate, profile),
                    "production_baseline": "unavailable",
                }
                atomic_json(self.archive / "recovery-cold-summary.json", results)
        atomic_json(self.archive / "recovery-cold-summary.json", results)


def speed_ratios(base: dict, candidate: dict, profile: str) -> tuple[float, float]:
    runtime = candidate["total_seconds"] / base["total_seconds"]
    secondary = float("inf")
    if profile == "balanced":
        field = "bundle_adjustment_peak_allocated_mib"
        original = base.get("vggt_phases", {}).get(field, 0)
        if original:
            secondary = candidate.get("vggt_phases", {}).get(field, original) / original
    if profile == "quality":

        def mvs(row: dict) -> float:
            return sum(row["colmap_phases"][key] for key in ("patchmatch_seconds", "fusion_seconds"))

        secondary = mvs(candidate) / mvs(base)
    return runtime, secondary


def median_speed_pass(pairs: list, profile: str) -> bool:
    runtime, secondary = map(
        statistics.median, zip(*(speed_ratios(base, cand, profile) for base, cand in pairs), strict=True)
    )
    if profile == "quality":
        return runtime <= 0.90 and secondary <= 0.80
    return runtime <= 0.85 or (profile == "balanced" and secondary <= 0.90)


def speed_pass(base: dict, candidate: dict, profile: str) -> bool:
    return median_speed_pass([(base, candidate)], profile)


def main() -> None:
    args = prepare()
    if os.environ.get("RESCENE_EXPERIMENT_ARCHIVE") != str(args.archive):
        raise ValueError("Use the same mounted archive in RESCENE_EXPERIMENT_ARCHIVE and --archive")
    supervisor.require_archive_mount()
    study = Study(args)
    study.smoke()
    baseline = study.baselines()
    atomic_json(study.archive / "baseline-summary.json", baseline)
    if args.rescreen:
        from rescene.pipeline import _environment

        study.lock = study.archive / f"{args.rescreen}-rescreen-environment-lock.json"
        atomic_json(study.lock, _environment(supervisor.SOURCE))
        screened = study.screen(baseline, args.rescreen)
        study.confirm(baseline, screened)
        study.recovery_cold(screened)
    elif args.recovery_cold_only:
        study.recovery_cold(read_json(study.archive / "screening-summary.json"))
    elif not args.baselines_only:
        screened = study.screen(baseline)
        study.confirm(baseline, screened)
        study.recovery_cold(screened)


if __name__ == "__main__":
    main()
