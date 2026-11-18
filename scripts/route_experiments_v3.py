"""Run one v3 route trial from a frozen specification."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
from pathlib import Path

from rescene.backends import BackendError
from rescene.config import ProfileConfig, profile_config
from rescene.metrics import final_ply_path
from rescene.pipeline import run_pipeline
from rescene.preprocess import discover_images, preprocess_input, sha256_file, source_id


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def validation_sources(scene: Path, rule: dict[str, object] | None) -> set[str] | None:
    if not rule:
        return None
    images = discover_images(scene)
    if "sources" in rule:
        indexes = rule["sources"]
        if (
            not isinstance(indexes, list)
            or not indexes
            or any(type(index) is not int or not 0 <= index < len(images) for index in indexes)
            or len(indexes) != len(set(indexes))
        ):
            raise ValueError("Frozen validation indexes must be unique, nonnegative, and within the source list")
        chosen = [images[index] for index in indexes]
    else:
        every = int(rule.get("every", 8))  # type: ignore[arg-type]
        if every < 1:
            raise ValueError("Validation stride must be positive")
        chosen = images[::every]
    return {source_id(scene, image.resolve()) for image in chosen}


def trial_config(spec: dict) -> ProfileConfig:
    config = profile_config(spec["profile"])
    overrides = dict(spec.get("overrides", {}))
    if "steps" in spec:
        overrides["gsplat_steps"] = spec["steps"]
    return config.with_overrides(overrides)


def frozen_inputs(spec: dict, scene: Path) -> dict[str, str]:
    if not scene.is_dir():
        raise ValueError("Expected a frozen image directory")
    hashes = {source_id(scene, image.resolve()): sha256_file(image) for image in discover_images(scene)}
    if "source_sha256" in spec and hashes != spec["source_sha256"]:
        raise ValueError("Source names or source SHA-256 differ from the frozen specification")
    if (matching_db := spec.get("matching_db")) and sha256_file(Path(matching_db)) != spec.get("matching_db_sha256"):
        raise ValueError("Matching database SHA-256 differs from the frozen specification")
    if (lock := spec.get("environment_lock")) and sha256_file(Path(lock)) != spec.get("environment_lock_sha256"):
        raise ValueError("Environment lock SHA-256 differs from the frozen specification")
    return hashes


def verify_selection(spec: dict, selection: dict, validation: set[str] | None) -> None:
    train = selection["train_source_ids"]
    held_out = selection["validation_source_ids"]
    if not train or not held_out or set(held_out) != validation:
        raise ValueError("Actual validation split differs from the frozen source set")
    if "selected_sources" in spec:
        expected = spec["selected_sources"]
        if set(train + held_out) != set(expected) or len(train + held_out) != len(expected):
            raise ValueError("Actual selected sources differ from the frozen selection")


def archive_trial(run: Path, archive_root: Path, identity: str, verdict: dict, keep_artifacts: bool) -> None:
    files = [
        path
        for path in run.iterdir()
        if path.is_file() and path.suffix in {".json", ".md"} and path.name != "trial_validation.json"
    ]
    for name in ("stages", "logs"):
        files.extend(path for path in (run / name).glob("*") if path.is_file())
    if keep_artifacts:
        import torch

        checkpoints = sorted((run / "gsplat" / "ckpts").glob("*.pt"))
        if len(checkpoints) != 1 or not checkpoints[0].stat().st_size:
            raise ValueError("Expected one final single-GPU checkpoint")
        checkpoint = torch.load(checkpoints[0], map_location="cpu", weights_only=True)
        means = checkpoint["splats"]["means"]
        if means.ndim != 2 or means.shape[1] != 3 or len(means) == 0 or not torch.isfinite(means).all():
            raise ValueError("Final Gaussian checkpoint failed reload verification")
        files.extend((checkpoints[0], final_ply_path(run), run / "scene.spz"))
    hashes = {path.relative_to(run).as_posix(): sha256_file(path) for path in files}
    manifest = {"identity": identity, "sha256": hashes, "validation": verdict}
    archive_root.mkdir(parents=True, exist_ok=True)
    target = archive_root / run.name
    if target.exists():
        if json.loads((target / "archive.json").read_text(encoding="utf-8")) != manifest or any(
            sha256_file(target / name) != digest for name, digest in hashes.items()
        ):
            raise ValueError("Existing archive differs from the current trial")
        return
    with tempfile.TemporaryDirectory(prefix=".trial-", dir=archive_root) as temp:
        staging = Path(temp) / run.name
        staging.mkdir()
        for path in files:
            name = path.relative_to(run).as_posix()
            destination = staging / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            if sha256_file(destination) != hashes[name]:
                raise ValueError(f"Archive SHA-256 mismatch: {name}")
        atomic_json(staging / "archive.json", manifest)
        staging.rename(target)


SUMMARY_FIELDS = (
    "psnr",
    "ssim",
    "lpips",
    "reprojection_error",
    "registration_rate",
    "validation_registration_rate",
    "total_seconds",
    "training_seconds",
    "gaussian_count",
    "ply_bytes",
    "spz_bytes",
)


def summarize(runs: Path, resources: Path, output: Path) -> None:
    """Summarize valid repeats per candidate and report per-run medians."""
    grouped: dict[str, dict[str, list[object]]] = {}
    failures: list[dict[str, object]] = []
    run_names = {path.name for path in runs.iterdir() if path.is_dir()} if runs.is_dir() else set()
    run_names.update(path.stem for path in resources.glob("*.json"))
    for name in sorted(run_names):
        run_dir = runs / name
        metrics_path = run_dir / "metrics.json"
        resource_path = resources / f"{name}.json"
        resource = json.loads(resource_path.read_text()) if resource_path.is_file() else {}
        validation_path = run_dir / "trial_validation.json"
        validation = json.loads(validation_path.read_text()) if validation_path.is_file() else {"valid": False}
        if not metrics_path.is_file() or not validation.get("valid") or resource.get("valid") is False:
            failures.append(
                {
                    "run": name,
                    "reason": resource.get("trial_failure")
                    or resource.get("abort_reason")
                    or validation.get("reason", "invalid trial"),
                    "validation": validation,
                }
            )
            continue
        metrics = json.loads(metrics_path.read_text())
        row = {field: metrics.get(field) for field in SUMMARY_FIELDS}
        row["repeat"] = json.loads((run_dir / "benchmark.json").read_text()).get("repeat")
        row["config_hash"] = metrics.get("config_hash")
        row["source_tree_sha256"] = json.loads((run_dir / "environment.json").read_text())["source_tree_sha256"]
        row["peak_full_pipeline_gpu_mib_sampled"] = resource.get("peak_owned_gpu_mib_sampled")
        row["wall_seconds"] = resource.get("wall_seconds")
        row["final_step"] = validation.get("final_step")
        row["validation_sources"] = validation.get("validation_sources")
        candidate = str(metrics.get("candidate_id"))
        bucket = grouped.setdefault(candidate, {"runs": [], "values": {field: [] for field in SUMMARY_FIELDS}})
        bucket["runs"].append({"run": run_dir.name, **row})
        for field in SUMMARY_FIELDS:
            value = row[field]
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                bucket["values"][field].append(float(value))
    import statistics

    summary = {"candidates": {}, "failures": failures}
    for candidate, bucket in sorted(grouped.items()):
        medians = {field: (statistics.median(values) if values else None) for field, values in bucket["values"].items()}
        summary["candidates"][candidate] = {
            "repeats": len(bucket["runs"]),
            "medians": medians,
            "ranges": {
                field: [min(values), max(values)] if values else None for field, values in bucket["values"].items()
            },
            "runs": bucket["runs"],
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output, summary)
    print(
        json.dumps(
            {
                "candidates": {name: value["medians"] for name, value in summary["candidates"].items()},
                "failures": failures,
            },
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("spec", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--repeat", type=int)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--summarize", type=Path)
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--verify-completed", action="store_true")
    args = parser.parse_args()
    if args.summarize:
        if args.resources is None or args.output_json is None:
            raise SystemExit("--summarize requires --resources and --output-json")
        summarize(args.summarize, args.resources, args.output_json)
        return
    if args.spec is None:
        raise SystemExit("spec is required")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    scene = Path(spec["scene"]).resolve()
    profile = str(spec["profile"])
    config = trial_config(spec)
    source_hashes = frozen_inputs(spec, scene)
    validation = validation_sources(scene, spec.get("validation"))
    seed = spec.get("seed")
    if seed is not None and (type(seed) is not int or not 0 <= seed < 2**32):
        raise ValueError("Trial seed must be an unsigned 32-bit integer")
    if args.preflight:
        with tempfile.TemporaryDirectory(prefix="rescene-preflight-") as directory:
            scratch = Path(directory)
            preprocess_input(
                scene,
                scratch,
                scene=spec["candidate_id"],
                max_frames=min(config.max_frames, spec.get("frame_limit", config.max_frames)),
                max_side=config.preprocess_max_side,
                validation_sources=validation,
                seed=42 if seed is None else seed,
            )
            selection = json.loads((scratch / "photometric_selection.json").read_text(encoding="utf-8"))
            verify_selection(spec, selection, validation)
        print(json.dumps({"sources": source_hashes, "selection": selection}, ensure_ascii=False))
        return
    if args.output is None or args.repeat is None:
        raise SystemExit("output and --repeat are required for a trial")
    identity = hashlib.sha256(
        json.dumps(
            {"configuration": config.to_dict(), "specification": spec, "sources": source_hashes, "repeat": args.repeat},
            sort_keys=True,
        ).encode()
    ).hexdigest()
    previous = args.output / "benchmark.json"
    if (args.resume or args.verify_completed) and (
        not previous.is_file() or json.loads(previous.read_text(encoding="utf-8"))["config_hash"] != identity
    ):
        raise ValueError("Cannot reuse trial: inputs, configuration, seed, or environment lock changed")
    archive = os.environ.get("RESCENE_EXPERIMENT_ARCHIVE")
    if args.verify_completed:
        verdict = json.loads((args.output / "trial_validation.json").read_text(encoding="utf-8"))
        if verdict.get("valid") is not True:
            raise ValueError("Trial is not valid")
        if archive:
            directory = Path(archive) / args.output.name
            manifest = json.loads((directory / "archive.json").read_text(encoding="utf-8"))
            if (
                manifest["identity"] != identity
                or manifest["validation"] != verdict
                or any(sha256_file(directory / name) != digest for name, digest in manifest["sha256"].items())
            ):
                raise ValueError("Completed trial archive failed verification")
        return
    if shutil.disk_usage(args.output.parent).free < 10 * 1024**3:
        raise RuntimeError("Less than 10 GiB free on data volume; refusing trial")
    metadata = {
        "dataset_id": spec.get("dataset", "vggt-example"),
        "scene_id": spec.get("scene_id", scene.parent.name),
        "candidate_id": spec["candidate_id"],
        "group": spec.get("group"),
        "config_hash": identity,
        "repeat": args.repeat,
        "purpose": spec.get("purpose", ""),
        "photometric_holdout": "explicit source IDs; cameras may use validation images",
    }
    if args.resume:
        (args.output / "trial_failure.json").unlink(missing_ok=True)
    reuse = {key: spec[key] for key in ("reuse_bundle", "reuse_sha256", "reuse_stage") if key in spec}
    try:
        run = run_pipeline(
            profile,
            scene,
            args.output.name,
            output_dir=args.output,
            config_override=config,
            frame_limit=spec.get("frame_limit"),
            validation_sources=validation if not reuse else None,
            record_hashes=True,
            diagnostics=bool(spec.get("diagnostics", False)),
            random_seed=seed,
            matching_db=Path(spec["matching_db"]) if spec.get("matching_db") else None,
            selected_sources=set(spec["selected_sources"]) if "selected_sources" in spec else None,
            metadata=metadata,
            resume=args.resume,
            **(
                {
                    "reuse_bundle": Path(reuse["reuse_bundle"]),
                    "reuse_sha256": reuse["reuse_sha256"],
                    "reuse_stage": reuse["reuse_stage"],
                }
                if reuse
                else {}
            ),
        )
    except BackendError as error:
        atomic_json(args.output / "trial_failure.json", {"reason": "algorithm", "detail": str(error)})
        raise
    metrics = json.loads((run / "metrics.json").read_text())
    expected_step = config.gsplat_steps - 1
    if metrics.get("degraded") is not None:
        atomic_json(
            run / "trial_validation.json", {"valid": False, "reason": "degraded", "degraded": metrics["degraded"]}
        )
        atomic_json(run / "trial_failure.json", {"reason": "degraded"})
        raise RuntimeError("Trial degraded; invalid for comparison")
    required = ("psnr", "ssim", "lpips", "reprojection_error", "registration_rate", "validation_registration_rate")
    for key in required:
        value = metrics.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Missing or non-finite metric: {key}")
    if metrics["photometric_step"] != expected_step or metrics["photometric_split"] != "val":
        raise ValueError("Wrong final validation step or split")
    if not validation:
        raise ValueError("Trial requires a frozen validation source set")
    rendered = [view["source_id"] for view in metrics["photometric_views"]]
    if set(rendered) != validation or len(rendered) != len(validation):
        atomic_json(run / "trial_failure.json", {"reason": "frozen_views_missing"})
        raise ValueError("Rendered validation views differ from the frozen source set")
    import spz

    ply = final_ply_path(run)
    original = spz.load_splat_from_ply(str(ply))
    exported = spz.load_spz(str(run / "scene.spz"))
    if original.num_points <= 0 or original.num_points != exported.num_points:
        raise ValueError("PLY/SPZ reload point count mismatch")
    verdict = {
        "valid": True,
        "candidate_id": metadata["candidate_id"],
        "final_step": metrics["photometric_step"],
        "validation_sources": sorted(validation),
        "ply_points": original.num_points,
        "spz_points": exported.num_points,
        "pose_and_gt_geometry": spec.get("pose_and_gt_geometry", "not measured for this scene"),
    }
    if archive:
        archive_trial(run, Path(archive), identity, verdict, spec.get("keep_artifacts", False))
        for relative in ("dense/workspace", "dense/stereo", "dense/images", "gsplat/ckpts", "gsplat/tb"):
            path = run / relative
            if path.is_dir() and path.resolve() == run.resolve() / relative:
                shutil.rmtree(path)
    atomic_json(run / "trial_validation.json", verdict)
    print(f"TRIAL_VALID {run}", flush=True)


if __name__ == "__main__":
    main()
