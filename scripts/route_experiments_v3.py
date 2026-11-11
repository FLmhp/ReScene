"""Run one v3 route trial from a frozen specification."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
from pathlib import Path

from rescene.config import profile_config
from rescene.metrics import final_ply_path
from rescene.pipeline import run_pipeline
from rescene.preprocess import discover_images, source_id


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def validation_sources(scene: Path, rule: dict[str, object] | None) -> set[str] | None:
    if not rule:
        return None
    images = discover_images(scene)
    if "sources" in rule:
        chosen = [images[int(index)] for index in rule["sources"]]  # type: ignore[union-attr]
    else:
        every = int(rule.get("every", 8))  # type: ignore[arg-type]
        chosen = images[::every]
    return {source_id(scene, image.resolve()) for image in chosen}


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
    for metrics_path in sorted(runs.glob("*/metrics.json")):
        run_dir = metrics_path.parent
        metrics = json.loads(metrics_path.read_text())
        validation_path = run_dir / "trial_validation.json"
        validation = json.loads(validation_path.read_text()) if validation_path.is_file() else {"valid": False}
        if not validation.get("valid"):
            failures.append({"run": run_dir.name, "reason": "invalid trial", "validation": validation})
            continue
        resource_path = resources / f"{run_dir.name}.json"
        resource = json.loads(resource_path.read_text()) if resource_path.is_file() else {}
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
    args = parser.parse_args()
    if args.summarize:
        if args.resources is None or args.output_json is None:
            raise SystemExit("--summarize requires --resources and --output-json")
        summarize(args.summarize, args.resources, args.output_json)
        return
    if args.spec is None or args.output is None or args.repeat is None:
        raise SystemExit("spec, output, and --repeat are required for a trial")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    if shutil.disk_usage(args.output.parent).free < 10 * 1024**3:
        raise RuntimeError("Less than 10 GiB free on data volume; refusing trial")
    scene = Path(spec["scene"])
    profile = str(spec["profile"])
    config = profile_config(profile)
    if spec.get("overrides"):
        config = config.with_overrides(dict(spec["overrides"]))
    if spec.get("steps"):
        config = config.with_overrides({"gsplat_steps": int(spec["steps"])})
    identity = hashlib.sha256(
        json.dumps(
            {"config": config.to_dict(), "scene": str(scene), "validation": spec.get("validation")}, sort_keys=True
        ).encode()
    ).hexdigest()
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
    validation = validation_sources(scene, spec.get("validation"))
    reuse = {key: spec[key] for key in ("reuse_bundle", "reuse_sha256", "reuse_stage") if key in spec}
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
    metrics = json.loads((run / "metrics.json").read_text())
    expected_step = config.gsplat_steps - 1
    if metrics.get("degraded") is not None:
        atomic_json(
            run / "trial_validation.json", {"valid": False, "reason": "degraded", "degraded": metrics["degraded"]}
        )
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
    rendered = {view["source_id"] for view in metrics["photometric_views"]}
    if rendered != validation:
        raise ValueError("Rendered validation views differ from the frozen source set")
    import spz

    ply = final_ply_path(run)
    original = spz.load_splat_from_ply(str(ply))
    exported = spz.load_spz(str(run / "scene.spz"))
    if original.num_points <= 0 or original.num_points != exported.num_points:
        raise ValueError("PLY/SPZ reload point count mismatch")
    for relative in ("dense/workspace", "dense/stereo", "dense/images", "gsplat/ckpts", "gsplat/tb"):
        intermediate = run / relative
        if intermediate.is_dir():
            shutil.rmtree(intermediate)
    atomic_json(
        run / "trial_validation.json",
        {
            "valid": True,
            "candidate_id": metadata["candidate_id"],
            "final_step": metrics["photometric_step"],
            "validation_sources": sorted(validation),
            "ply_points": original.num_points,
            "spz_points": exported.num_points,
            "pose_and_gt_geometry": spec.get("pose_and_gt_geometry", "not measured for this scene"),
        },
    )
    print(f"TRIAL_VALID {run}", flush=True)


if __name__ == "__main__":
    main()
