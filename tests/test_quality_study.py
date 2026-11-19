from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest
from PIL import Image

from rescene.backends import colmap_command, vggt_command
from rescene.colmap_runner import _check_shared_images
from rescene.config import profile_config
from rescene.preprocess import preprocess_input
from rescene.vggt_runner import _coverage_rank, coverage_queries, grid_sample
from scripts.quality_study import median_speed_pass, pair_quality


def test_fast_grid_sampling_reserves_tiles_and_excludes_padding() -> None:
    confidence = np.full((2, 32, 32), 1.6)
    confidence[0] = 8
    depth = np.ones_like(confidence)
    bounds = [[4, 4, 28, 28]] * 2
    depth[1, 4, 4] = np.nan
    mask = grid_sample(confidence, depth, bounds, 750, seed=42)
    assert mask.sum() == 750
    assert mask[1].sum() == 16 * 16
    assert not mask[:, :4].any()
    assert not mask[1, 4, 4]
    assert np.array_equal(mask, grid_sample(confidence, depth, bounds, 750, seed=42))


def test_balanced_queries_cover_distinct_clusters_with_fixed_first_frame() -> None:
    distances = np.ones((14, 14))
    distances[:7, :7] = distances[7:, 7:] = 0.1
    assert coverage_queries(distances, 2) == [0, 7]
    assert coverage_queries(distances, 4) == [0, 7, 1, 2]


def test_dino_adapter_converts_autocast_tensor_before_numpy() -> None:
    tensor = Mock()
    cast = tensor.detach.return_value.float
    cast.return_value.cpu.return_value.numpy.return_value = np.eye(4)
    assert _coverage_rank(tensor, 2, 2) == [0, 1]
    cast.assert_called_once_with()


def test_frozen_dslr_inputs_keep_quality_warnings_and_split(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for name in ("a.jpg", "b.jpg", "c.jpg"):
        Image.new("RGB", (100, 100), "black").save(source / name)
    manifest = preprocess_input(
        source,
        tmp_path / "output",
        scene="office",
        max_frames=3,
        validation_sources={"b.jpg"},
        retain_frozen_sources=True,
        record_hashes=True,
    )
    assert manifest["counts"]["selected"] == 3
    assert manifest["frames"][1]["duplicate"] and manifest["frames"][1]["quality_rejected"]
    assert [row["source_id"] for row in manifest["frames"] if row["validation"]] == ["b.jpg"]
    assert all(row["source_sha256"] for row in manifest["frames"])


def test_shared_camera_requires_equal_image_dimensions_and_known_model(tmp_path: Path) -> None:
    Image.new("RGB", (100, 100)).save(tmp_path / "a.jpg")
    Image.new("RGB", (101, 100)).save(tmp_path / "b.jpg")
    with pytest.raises(ValueError, match="identical dimensions"):
        _check_shared_images(tmp_path)
    with pytest.raises(ValueError, match="PINHOLE"):
        profile_config("quality").with_overrides({"colmap_shared_camera": True})
    candidate = profile_config("quality").with_overrides(
        {"colmap_shared_camera": True, "colmap_camera_model": "PINHOLE", "colmap_mvs_iterations": 3}
    )
    command = colmap_command(
        tmp_path,
        sequential=False,
        dense=True,
        camera_model=candidate.colmap_camera_model,
        shared_camera=candidate.colmap_shared_camera,
        mvs_iterations=candidate.colmap_mvs_iterations,
    )
    assert "--shared-camera" in command and command[command.index("--mvs-iterations") + 1] == "3"
    regular = profile_config("fast")
    assert "--grid-sampling" not in vggt_command(tmp_path, tmp_path, regular)
    assert "--grid-sampling" in vggt_command(tmp_path, tmp_path, regular.with_overrides({"vggt_grid_sampling": True}))


def test_quality_gate_uses_common_views_and_rejects_dense_regression() -> None:
    view = {"psnr": 20, "ssim": 0.8, "lpips": 0.2, "scoring_width": 1600, "scoring_height": 1066}
    base = {
        "valid": True,
        "supported": list(range(8)),
        "views": dict.fromkeys(range(8), view),
        "registration_rate": 1,
        "peak_mib": 1000,
        "gpu_total_mib": 32607,
        "point_fscore": 0.3,
    }
    partial = {**base, "supported": list(range(7))}
    assert pair_quality(base, partial, "quality", strict=False) == []
    assert pair_quality(base, partial, "quality", strict=True) == ["validation_coverage"]
    assert pair_quality(base, {**base, "point_fscore": 0.27}, "quality", strict=True) == ["dense_f1"]
    pairs = [({"total_seconds": 100}, {"total_seconds": value}) for value in (82, 84, 110)]
    assert median_speed_pass(pairs, "fast")
