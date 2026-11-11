"""Bundle-adjustment diagnostics tests; they need the pinned pycolmap build."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rescene.geometry_metrics import _observed_points, compare_bundle_adjustment, projection_error_stats

pycolmap = pytest.importorskip("pycolmap")

FOCAL = 500.0
WIDTH = 640
HEIGHT = 480
CENTER = (320.0, 240.0)


def _write_text_model(
    path: Path,
    points: list[tuple[int, tuple[float, float, float], tuple[float, float]]],
    image_name: str = "000000.jpg",
) -> None:
    """Write a minimal COLMAP text model: one identity-pose image with given points/observations."""
    path.mkdir(parents=True, exist_ok=True)
    (path / "cameras.txt").write_text(
        f"1 SIMPLE_PINHOLE {WIDTH} {HEIGHT} {FOCAL} {CENTER[0]} {CENTER[1]}\n", encoding="utf-8"
    )
    observations = " ".join(f"{u} {v} {point_id}" for point_id, _xyz, (u, v) in points)
    (path / "images.txt").write_text(f"1 1 0 0 0 0 0 0 1 {image_name}\n{observations}\n", encoding="utf-8")
    lines = [
        f"{point_id} {xyz[0]} {xyz[1]} {xyz[2]} 255 0 0 0.0 1 {index}"
        for index, (point_id, xyz, _observed) in enumerate(points)
    ]
    (path / "points3D.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _project(x: float, y: float, z: float) -> tuple[float, float]:
    return FOCAL * x / z + CENTER[0], FOCAL * y / z + CENTER[1]


def test_compare_bundle_adjustment_uses_common_observations(tmp_path: Path) -> None:
    before = tmp_path / "sparse-pre-ba"
    after = tmp_path / "sparse"
    # A measured pixel that only the post-BA point explains exactly.
    observed = _project(0.0, 0.0, 2.0)
    _write_text_model(before, [(7, (0.01, 0.0, 2.0), observed)])
    extra = _project(0.02, 0.0, 2.0)
    _write_text_model(after, [(7, (0.0, 0.0, 2.0), observed), (9, (0.02, 0.0, 2.0), extra)])

    result = compare_bundle_adjustment(before, after, tmp_path / "geometry-ba.json")

    assert result["common_observations"] == 1
    assert result["before"]["observations"] == 1
    # 500 px focal at z=2 turns a 0.01 world-unit offset into 2.5 px.
    assert result["before"]["mean"] == pytest.approx(2.5, abs=1e-6)
    assert result["after"]["mean"] == pytest.approx(0.0, abs=1e-6)
    assert result["improved_ratio"] == 1.0
    assert json.loads((tmp_path / "geometry-ba.json").read_text(encoding="utf-8"))["common_observations"] == 1


def test_compare_bundle_adjustment_matches_renamed_images(tmp_path: Path) -> None:
    """The pre-BA snapshot keeps placeholder names; ids still identify the images."""
    before = tmp_path / "sparse-pre-ba"
    after = tmp_path / "sparse"
    observed = _project(0.0, 0.0, 2.0)
    _write_text_model(before, [(7, (0.01, 0.0, 2.0), observed)], image_name="image_1")
    _write_text_model(after, [(7, (0.0, 0.0, 2.0), observed)], image_name="000000.jpg")

    result = compare_bundle_adjustment(before, after, tmp_path / "geometry-ba.json")

    assert result["common_observations"] == 1
    assert result["before"]["mean"] == pytest.approx(2.5, abs=1e-6)
    assert result["after"]["mean"] == pytest.approx(0.0, abs=1e-6)


def test_projection_error_stats_measure_pixels(tmp_path: Path) -> None:
    model = tmp_path / "model"
    _write_text_model(model, [(7, (0.01, 0.0, 2.0), _project(0.0, 0.0, 2.0))])

    reconstruction = pycolmap.Reconstruction(str(model))
    stats = projection_error_stats(reconstruction)

    assert stats["observations"] == 1
    assert stats["mean"] == pytest.approx(2.5, abs=1e-6)
    assert stats["median"] == pytest.approx(2.5, abs=1e-6)
    assert len(_observed_points(reconstruction)) == 1
