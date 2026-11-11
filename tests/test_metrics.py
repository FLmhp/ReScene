import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from rescene.metrics import (
    _mean_reprojection_error,
    _photometric_metrics,
    collect_metrics,
    final_ply_path,
    validation_registration,
)


def _photometric_fixture(run_dir: Path) -> None:
    (run_dir / "gsplat" / "stats").mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps({"gsplat_steps": 10}), encoding="utf-8")
    split = {
        "train_source_ids": ["train.jpg"],
        "validation_source_ids": ["val.jpg"],
        "image_to_source_id": {"000000.jpg": "train.jpg", "000001.jpg": "val.jpg"},
    }
    views = {
        "step": 9,
        "split": "val",
        "train_source_ids": ["train.jpg"],
        "validation_source_ids": ["val.jpg"],
        "views": [{"source_id": "val.jpg", "image_name": "000001.jpg", "psnr": 20.1, "ssim": 0.8, "lpips": 0.2}],
    }
    (run_dir / "photometric_selection.json").write_text(json.dumps(split), encoding="utf-8")
    (run_dir / "photometric_split.json").write_text(json.dumps(split), encoding="utf-8")
    (run_dir / "gsplat" / "photometric_views.json").write_text(json.dumps(views), encoding="utf-8")
    (run_dir / "gsplat" / "run.json").write_text(json.dumps({"ply_step": 9, "eval_step": 9}), encoding="utf-8")
    (run_dir / "gsplat" / "stats" / "val_step0009.json").write_text(
        json.dumps({"psnr": 20.1, "ssim": 0.8, "lpips": 0.2}), encoding="utf-8"
    )


def test_metrics_aggregate_upstream_outputs(tmp_path: Path) -> None:
    (tmp_path / "stages").mkdir()
    (tmp_path / "gsplat" / "ply").mkdir(parents=True)
    _photometric_fixture(tmp_path)
    (tmp_path / "stages" / "train.json").write_text(
        json.dumps({"stage": "training", "duration_seconds": 3.5}), encoding="utf-8"
    )
    (tmp_path / "input_manifest.json").write_text(json.dumps({"counts": {"selected": 8}}), encoding="utf-8")
    (tmp_path / "gsplat" / "stats" / "val.json").write_text(
        json.dumps({"psnr": 20.1, "ssim": 0.8, "lpips": 0.2}), encoding="utf-8"
    )
    (tmp_path / "gsplat" / "stats" / "train.json").write_text(json.dumps({"mem": 2.0}), encoding="utf-8")
    (tmp_path / "gsplat" / "ply" / "point_cloud_9.ply").write_text(
        "ply\nformat ascii 1.0\nelement vertex 42\nend_header\n", encoding="ascii"
    )
    (tmp_path / "scene.spz").write_bytes(b"spz")
    (tmp_path / "benchmark.json").write_text(
        json.dumps({"dataset_id": "dtu", "scene_id": "scan24", "candidate_id": "baseline"}), encoding="utf-8"
    )
    (tmp_path / "dense").mkdir()
    (tmp_path / "dense" / "fused.ply").write_text(
        "ply\nformat ascii 1.0\nelement vertex 12\nend_header\n", encoding="ascii"
    )

    metrics = collect_metrics(tmp_path)

    assert metrics["psnr"] == 20.1
    assert metrics["gaussian_count"] == 42
    assert metrics["training_seconds"] == 3.5
    assert metrics["peak_vram_mb"] == 2048
    assert metrics["spz_bytes"] == 3
    assert metrics["dataset_id"] == "dtu"
    assert metrics["dense_point_count"] == 12


def test_reprojection_error_ignores_nonphysical_point_errors() -> None:
    reconstruction = SimpleNamespace(
        update_point_3d_errors=lambda: None,
        cameras={1: SimpleNamespace(width=640, height=480)},
        points3D={
            1: SimpleNamespace(error=0.5),
            2: SimpleNamespace(error=1.5),
            3: SimpleNamespace(error=float("inf")),
            4: SimpleNamespace(error=1e150),
        },
    )
    assert _mean_reprojection_error(reconstruction) == 1.0


def test_validation_registration_counts_frames_with_points() -> None:
    frames = [
        {"source_id": "a/000000.jpg"},
        {"source_id": "b/000000.jpg"},
        {"source_id": "c/000000.jpg"},
    ]

    registered = validation_registration(frames, {"a/000000.jpg": 12, "b/000000.jpg": 0})
    assert registered["validation_registered"] == 1
    assert registered["validation_registered_frames"] == ["a/000000.jpg"]
    assert registered["validation_registration_rate"] == 1 / 3

    missing = validation_registration(frames, {})
    assert missing["validation_registered"] == 0
    assert missing["validation_registration_rate"] == 0.0

    assert validation_registration([], {"000000.jpg": 4})["validation_registration_rate"] is None


def test_collect_metrics_reports_validation_frame_totals(tmp_path: Path) -> None:
    (tmp_path / "input_manifest.json").write_text(
        json.dumps(
            {
                "counts": {"selected": 4},
                "frames": [
                    {"source": "a.jpg", "file": "images/000000.jpg", "selected": True, "validation": True},
                    {"source": "b.jpg", "file": "images/000001.jpg", "selected": True, "validation": False},
                    {"source": "c.jpg", "file": "images/000002.jpg", "selected": False, "validation": False},
                ],
            }
        ),
        encoding="utf-8",
    )

    metrics = collect_metrics(tmp_path)

    assert metrics["validation_selected"] == ["a.jpg"]
    assert metrics["validation_frames_total"] == 1
    assert metrics["validation_registration_rate"] is None


@pytest.mark.parametrize(
    "case", ["step", "split", "empty", "leak", "mismatch", "duplicate", "image", "view_nan", "stats_nan", "aggregate"]
)
def test_photometric_metrics_reject_invalid_provenance(tmp_path: Path, case: str) -> None:
    _photometric_fixture(tmp_path)
    split_path = tmp_path / "photometric_split.json"
    views_path = tmp_path / "gsplat" / "photometric_views.json"
    stats_path = tmp_path / "gsplat" / "stats" / "val_step0009.json"
    split = json.loads(split_path.read_text(encoding="utf-8"))
    views = json.loads(views_path.read_text(encoding="utf-8"))
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if case == "step":
        views["step"] = 8
    elif case == "split":
        views["split"] = "train"
    elif case == "empty":
        split["validation_source_ids"] = []
    elif case == "leak":
        split["validation_source_ids"] = ["train.jpg"]
    elif case == "mismatch":
        views["validation_source_ids"] = ["other.jpg"]
    elif case == "duplicate":
        views["views"].append(views["views"][0])
    elif case == "image":
        views["views"][0]["image_name"] = "000000.jpg"
    elif case == "view_nan":
        views["views"][0]["psnr"] = float("nan")
    elif case == "stats_nan":
        stats["ssim"] = float("inf")
    else:
        stats["psnr"] = 99
    split_path.write_text(json.dumps(split), encoding="utf-8")
    views_path.write_text(json.dumps(views), encoding="utf-8")
    stats_path.write_text(json.dumps(stats), encoding="utf-8")
    with pytest.raises(ValueError):
        _photometric_metrics(tmp_path)


def test_photometric_metrics_ignore_nonfinal_statistics(tmp_path: Path) -> None:
    _photometric_fixture(tmp_path)
    (tmp_path / "gsplat" / "stats" / "val_step0010.json").write_text(
        json.dumps({"psnr": 999, "ssim": 999, "lpips": 999}), encoding="utf-8"
    )
    assert _photometric_metrics(tmp_path)["psnr"] == 20.1


def test_photometric_metrics_reject_omitted_frozen_validation(tmp_path: Path) -> None:
    _photometric_fixture(tmp_path)
    path = tmp_path / "photometric_selection.json"
    selection = json.loads(path.read_text(encoding="utf-8"))
    selection["validation_source_ids"].append("missing.jpg")
    path.write_text(json.dumps(selection), encoding="utf-8")
    with pytest.raises(ValueError, match="selected validation"):
        _photometric_metrics(tmp_path)


def test_final_ply_requires_matching_run_metadata(tmp_path: Path) -> None:
    _photometric_fixture(tmp_path)
    ply_dir = tmp_path / "gsplat" / "ply"
    ply_dir.mkdir()
    final = ply_dir / "point_cloud_9.ply"
    final.write_text("final", encoding="utf-8")
    (ply_dir / "point_cloud_999.ply").write_text("stale", encoding="utf-8")
    assert final_ply_path(tmp_path) == final
    (tmp_path / "gsplat" / "run.json").write_text(json.dumps({"ply_step": 999, "eval_step": 9}), encoding="utf-8")
    with pytest.raises(ValueError, match="final step"):
        final_ply_path(tmp_path)
