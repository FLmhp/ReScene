"""Collect stable metrics from upstream artifacts without depending on their log format."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _find_number(value: Any, names: set[str]) -> float | None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in names and isinstance(item, (int, float)) and math.isfinite(item):
                return float(item)
        for item in value.values():
            found = _find_number(item, names)
            if found is not None:
                return found
    if isinstance(value, list):
        for item in reversed(value):
            found = _find_number(item, names)
            if found is not None:
                return found
    return None


def _read_json_files(directory: Path) -> list[Any]:
    values: list[Any] = []
    if directory.exists():
        for path in directory.rglob("*.json"):
            try:
                values.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
    return values


def final_ply_path(run_dir: Path) -> Path:
    """Return the PLY recorded for the configured final training step."""
    config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    run = json.loads((run_dir / "gsplat" / "run.json").read_text(encoding="utf-8"))
    steps = config.get("gsplat_steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or steps <= 0:
        raise ValueError("Invalid configured gsplat_steps")
    expected = steps - 1
    if any(type(run.get(key)) is not int or run[key] != expected for key in ("ply_step", "eval_step")):
        raise ValueError("gsplat run metadata does not record the configured final step")
    path = run_dir / "gsplat" / "ply" / f"point_cloud_{expected}.ply"
    if not path.is_file():
        raise FileNotFoundError(f"Final gsplat PLY is missing: {path}")
    return path


def _ply_vertices(path: Path | None) -> int | None:
    if path is None or not path.exists():
        return None
    with path.open("rb") as stream:
        for raw_line in stream:
            line = raw_line.decode("ascii", errors="ignore").strip()
            if line.startswith("element vertex "):
                return int(line.rsplit(" ", 1)[-1])
            if line == "end_header":
                break
    return None


def _mean_reprojection_error(reconstruction: Any) -> float | None:
    reconstruction.update_point_3d_errors()
    max_error = max(
        (math.hypot(camera.width, camera.height) for camera in reconstruction.cameras.values()),
        default=0.0,
    )
    errors = [
        float(point.error)
        for point in reconstruction.points3D.values()
        if math.isfinite(point.error) and 0 <= point.error <= max_error
    ]
    return math.fsum(errors) / len(errors) if errors else None


def validation_registration(
    validation_frames: list[dict[str, object]],
    registered_names: dict[str, int],
) -> dict[str, object]:
    """Measure how many selected validation frames registered with sparse points.

    ``registered_names`` maps source IDs to their 3D point counts. A
    validation frame counts as registered only when it produced at least one
    3D point; a registered pose alone is not enough to score the frame.
    """
    registered = [
        str(frame.get("source_id"))
        for frame in validation_frames
        if registered_names.get(str(frame.get("source_id")), 0) > 0
    ]
    total = len(validation_frames)
    return {
        "validation_registered_frames": registered,
        "validation_registered": len(registered),
        "validation_registration_rate": len(registered) / total if total else None,
    }


def _photometric_metrics(run_dir: Path) -> dict[str, object]:
    """Read only the configured final validation evaluation with verified views."""
    config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    steps = config.get("gsplat_steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or steps <= 0:
        raise ValueError("Invalid configured gsplat_steps")
    step = steps - 1
    split = json.loads((run_dir / "photometric_split.json").read_text(encoding="utf-8"))
    rendered = json.loads((run_dir / "gsplat" / "photometric_views.json").read_text(encoding="utf-8"))
    if rendered.get("split") != "val" or type(rendered.get("step")) is not int or rendered["step"] != step:
        raise ValueError("Photometric views are not from the final validation step")

    def ids(value: object, label: str) -> set[str]:
        if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
            raise ValueError(f"Invalid {label} source IDs")
        result = set(value)
        if len(result) != len(value):
            raise ValueError(f"Duplicate {label} source IDs")
        return result

    train = ids(split.get("train_source_ids"), "training")
    val = ids(split.get("validation_source_ids"), "validation")
    selection = json.loads((run_dir / "photometric_selection.json").read_text(encoding="utf-8"))
    selected_train = ids(selection.get("train_source_ids"), "selected training")
    selected_val = ids(selection.get("validation_source_ids"), "selected validation")
    if not selected_train or not selected_val or selected_train & selected_val:
        raise ValueError("Selected train and validation splits must be nonempty and disjoint")
    if val != selected_val or not train <= selected_train:
        raise ValueError("Registered split does not match selected validation or training sources")
    if not train or not val or train & val:
        raise ValueError("Photometric train and validation splits must be nonempty and disjoint")
    if ids(rendered.get("train_source_ids"), "rendered training") != train:
        raise ValueError("Rendered training split does not match manifest")
    if ids(rendered.get("validation_source_ids"), "rendered validation") != val:
        raise ValueError("Rendered validation split does not match manifest")
    views = rendered.get("views")
    if not isinstance(views, list) or any(not isinstance(view, dict) for view in views):
        raise ValueError("Invalid photometric views")
    if ids([view.get("source_id") for view in views], "per-view") != val:
        raise ValueError("Per-view source IDs do not match validation split")
    mapping = split.get("image_to_source_id")
    if (
        not isinstance(mapping, dict)
        or any(
            not isinstance(key, str) or not key or not isinstance(value, str) or not value
            for key, value in mapping.items()
        )
        or len(mapping) != len(train | val)
        or set(mapping.values()) != train | val
        or any(
            not isinstance(view.get("image_name"), str) or mapping.get(view["image_name"]) != view["source_id"]
            for view in views
        )
    ):
        raise ValueError("Per-view image provenance does not match split manifest")
    for view in views:
        for name in ("psnr", "ssim", "lpips"):
            value = view.get(name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Invalid per-view {name}")
    stats_path = run_dir / "gsplat" / "stats" / f"val_step{step:04d}.json"
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    result: dict[str, object] = {}
    for name in ("psnr", "ssim", "lpips"):
        value = stats.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Invalid final validation {name}")
        mean = math.fsum(float(view[name]) for view in views) / len(views)
        if not math.isclose(float(value), mean, rel_tol=1e-6, abs_tol=1e-7):
            raise ValueError(f"Final validation {name} does not match rendered views")
        result[name] = float(value)
    result["photometric_step"] = step
    result["photometric_split"] = "val"
    result["photometric_views"] = views
    return result


def collect_metrics(run_dir: Path, degraded: dict[str, object] | None = None) -> dict[str, object]:
    stages = _read_json_files(run_dir / "stages")
    trainer_values = _read_json_files(run_dir / "gsplat")
    ply = final_ply_path(run_dir) if (run_dir / "gsplat").exists() else None
    spz = run_dir / "scene.spz"
    manifest_path = run_dir / "input_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    benchmark_path = run_dir / "benchmark.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8")) if benchmark_path.exists() else {}
    selected = int(manifest.get("counts", {}).get("selected", 0))
    validation_frames = [
        frame for frame in manifest.get("frames", []) if frame.get("selected") and frame.get("validation")
    ]
    duration = sum(float(item.get("duration_seconds", 0)) for item in stages if isinstance(item, dict))
    peak_vram_mb = _find_number(trainer_values, {"peak_vram_mb", "max_memory_mb"})
    if peak_vram_mb is None:
        memory_gib = _find_number(trainer_values, {"mem"})
        peak_vram_mb = memory_gib * 1024 if memory_gib is not None else None
    metrics: dict[str, object] = {
        "schema_version": 2,
        "dataset_id": benchmark.get("dataset_id"),
        "scene_id": benchmark.get("scene_id"),
        "candidate_id": benchmark.get("candidate_id"),
        "config_hash": benchmark.get("config_hash"),
        "registered_images": None,
        "registration_rate": None,
        "validation_selected": [str(frame.get("source_id", frame.get("source"))) for frame in validation_frames],
        "validation_registered_frames": [],
        "validation_frames_total": len(validation_frames),
        "validation_registered": None,
        "validation_registration_rate": None,
        "reprojection_error": None,
        "pose_ate": None,
        "pose_rotation_error": None,
        "point_accuracy": None,
        "point_completeness": None,
        "point_fscore": None,
        "training_seconds": next(
            (item.get("duration_seconds") for item in stages if item.get("stage") == "training"), None
        ),
        "total_seconds": round(duration, 3),
        "psnr": None,
        "ssim": None,
        "lpips": None,
        "gaussian_count": _ply_vertices(ply),
        "peak_vram_mb": peak_vram_mb,
        "ply_bytes": ply.stat().st_size if ply else None,
        "spz_bytes": spz.stat().st_size if spz.exists() else None,
        "dense_point_count": _ply_vertices(run_dir / "dense" / "fused.ply"),
        "mesh_vertex_count": _ply_vertices(run_dir / "dense" / "meshed-poisson.ply"),
        "degraded": degraded,
    }
    if (run_dir / "gsplat").exists():
        metrics.update(_photometric_metrics(run_dir))
    sparse = run_dir / "sparse" / "0"
    if not sparse.exists():
        sparse = run_dir / "sparse"
    try:
        import pycolmap

        reconstruction = pycolmap.Reconstruction(sparse)
        registered = reconstruction.num_reg_images()
        metrics["registered_images"] = registered
        metrics["registration_rate"] = registered / selected if selected else None
        metrics["reprojection_error"] = _mean_reprojection_error(reconstruction)
        split_path = run_dir / "photometric_split.json"
        if split_path.is_file():
            image_to_source = json.loads(split_path.read_text(encoding="utf-8"))["image_to_source_id"]
            metrics.update(
                validation_registration(
                    validation_frames,
                    {
                        image_to_source[image.name]: image.num_points3D
                        for image in reconstruction.images.values()
                        if image.name in image_to_source
                    },
                )
            )
    except (ImportError, RuntimeError, ValueError):
        pass
    return metrics


def write_report(run_dir: Path, metrics: dict[str, object]) -> Path:
    profile = "unknown"
    config_path = run_dir / "config.json"
    if config_path.exists():
        profile = json.loads(config_path.read_text(encoding="utf-8")).get("name", profile)
    rows = "\n".join(f"| {key} | {value} |" for key, value in metrics.items())
    report = f"# ReScene run `{run_dir.name}`\n\nProfile: `{profile}`\n\n| Metric | Value |\n|---|---|\n{rows}\n"
    path = run_dir / "report.md"
    path.write_text(report, encoding="utf-8")
    return path
