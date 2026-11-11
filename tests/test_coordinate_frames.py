import json
from pathlib import Path

import numpy as np
import pytest

from rescene.coordinate_frames import artifact_to_colmap


def _manifest(run_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    forward = np.array([[0.0, -2, 0, 3], [2, 0, 0, -4], [0, 0, 2, 5], [0, 0, 0, 1]])
    inverse = np.linalg.inv(forward)
    (run_dir / "geometry_frames.json").write_text(
        json.dumps(
            {
                "colmap_to_trainer": forward.tolist(),
                "trainer_to_colmap": inverse.tolist(),
                "artifacts": {"gsplat": "trainer", "dense/fused.ply": "colmap"},
            }
        ),
        encoding="utf-8",
    )
    return forward, inverse


def test_artifact_frames_and_transform_composition(tmp_path: Path) -> None:
    forward, inverse = _manifest(tmp_path)
    transform, frame = artifact_to_colmap(tmp_path, tmp_path / "gsplat" / "ply" / "scene.ply")
    assert frame == "trainer"
    assert np.allclose(transform, inverse)
    colmap_point = np.array([1.0, 2, 3, 1])
    colmap_to_gt = np.array([[0.0, -3, 0, 6], [3, 0, 0, 7], [0, 0, 3, -2], [0, 0, 0, 1]])
    assert np.allclose(colmap_to_gt @ transform @ forward @ colmap_point, colmap_to_gt @ colmap_point)
    transform, frame = artifact_to_colmap(tmp_path, tmp_path / "dense" / "fused.ply")
    assert frame == "colmap"
    assert np.array_equal(transform, np.eye(4))


def test_legacy_run_without_metadata_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Coordinate frame metadata"):
        artifact_to_colmap(tmp_path, tmp_path / "gsplat" / "scene.ply")


def test_unknown_artifact_is_rejected(tmp_path: Path) -> None:
    _manifest(tmp_path)
    with pytest.raises(ValueError, match="No coordinate frame"):
        artifact_to_colmap(tmp_path, tmp_path / "other.ply")


def test_inconsistent_transforms_are_rejected(tmp_path: Path) -> None:
    _manifest(tmp_path)
    path = tmp_path / "geometry_frames.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["trainer_to_colmap"] = np.eye(4).tolist()
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="not inverses"):
        artifact_to_colmap(tmp_path, tmp_path / "gsplat" / "scene.ply")


@pytest.mark.parametrize("value", [None, [[1, 2]], [[float("nan")] * 4] * 4, np.zeros((4, 4)).tolist()])
def test_invalid_transform_is_rejected(tmp_path: Path, value: object) -> None:
    _manifest(tmp_path)
    path = tmp_path / "geometry_frames.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["colmap_to_trainer"] = value
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="colmap_to_trainer"):
        artifact_to_colmap(tmp_path, tmp_path / "gsplat" / "scene.ply")


def test_artifact_prefix_matches_path_components(tmp_path: Path) -> None:
    _manifest(tmp_path)
    with pytest.raises(ValueError, match="No coordinate frame"):
        artifact_to_colmap(tmp_path, tmp_path / "gsplat-other" / "scene.ply")


def test_missing_transform_is_rejected_even_for_colmap_artifact(tmp_path: Path) -> None:
    _manifest(tmp_path)
    path = tmp_path / "geometry_frames.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    del data["trainer_to_colmap"]
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="trainer_to_colmap"):
        artifact_to_colmap(tmp_path, tmp_path / "dense" / "fused.ply")
