import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rescene.evaluation import (
    _parse_official_scores,
    _read_ply_xyz,
    _read_reference_cloud,
    _write_ply_xyz,
    evaluate_run,
    point_errors,
    pose_errors,
    similarity_alignment,
)


def test_similarity_alignment_recovers_transform() -> None:
    source = np.asarray([[0.0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]])
    rotation = np.asarray([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]])
    target = 2.5 * (source @ rotation.T) + np.asarray([3.0, -2, 7])

    scale, actual_rotation, translation = similarity_alignment(source, target)

    assert np.isclose(scale, 2.5)
    assert np.allclose(actual_rotation, rotation)
    assert np.allclose(translation, [3, -2, 7])


def test_pose_errors_are_zero_after_similarity_alignment() -> None:
    source = np.asarray([[0.0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]])
    alignment = np.asarray([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]])
    target = 2 * (source @ alignment.T) + 3
    predicted_rotations = np.repeat(np.eye(3)[None, ...], len(source), axis=0)
    target_rotations = predicted_rotations @ alignment.T

    ate, rotation_error, _ = pose_errors(source, target, predicted_rotations, target_rotations)

    assert ate < 1e-12
    # SVD round-off differs per BLAS; 1e-5 rad (0.0006 deg) still fails a real misalignment.
    assert rotation_error < 1e-5


def test_read_ascii_ply_xyz_ignores_other_properties(tmp_path: Path) -> None:
    path = tmp_path / "cloud.ply"
    path.write_text(
        "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\n"
        "property float z\nproperty uchar red\nend_header\n1 2 3 255\n4 5 6 0\n",
        encoding="ascii",
    )

    assert np.array_equal(_read_ply_xyz(path), np.asarray([[1, 2, 3], [4, 5, 6]]))


def test_meshlab_reference_applies_cloud_transform(tmp_path: Path) -> None:
    cloud = tmp_path / "scan.ply"
    cloud.write_text(
        "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\n"
        "property float z\nend_header\n1 2 3\n",
        encoding="ascii",
    )
    project = tmp_path / "scan.mlp"
    project.write_text(
        '<MeshLabProject><MeshGroup><MLMesh filename="scan.ply"><MLMatrix44>'
        "1 0 0 4 0 1 0 5 0 0 1 6 0 0 0 1"
        "</MLMatrix44></MLMesh></MeshGroup></MeshLabProject>",
        encoding="utf-8",
    )

    assert np.array_equal(_read_reference_cloud(project), np.asarray([[5, 7, 9]]))


def test_point_errors_match_identical_clouds() -> None:
    pytest.importorskip("scipy")
    points = np.asarray([[0.0, 0, 0], [1, 1, 1]])

    assert point_errors(points, points, 0.01) == (0.0, 0.0, 1.0)


def test_binary_ply_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "aligned.ply"
    points = np.asarray([[1.5, 2, 3], [4, 5, 6]], dtype=np.float64)

    _write_ply_xyz(path, points)

    assert np.allclose(_read_ply_xyz(path), points)


def test_parse_official_scores() -> None:
    output = "Tolerances: 0.02\nCompletenesses: 0.75\nAccuracies: 0.5\nF1-scores: 0.6\n"

    assert _parse_official_scores(output) == (0.5, 0.75, 0.6)


def _run_dir_with_cloud(tmp_path: Path) -> Path:
    run_dir = tmp_path / "run"
    (run_dir / "dense").mkdir(parents=True)
    _write_ply_xyz(run_dir / "dense" / "fused.ply", np.asarray([[1.0, 2, 3]]))
    (run_dir / "metrics.json").write_text("{}", encoding="utf-8")
    return run_dir


def test_official_evaluation_requires_reference_model(tmp_path: Path) -> None:
    run_dir = _run_dir_with_cloud(tmp_path)
    with pytest.raises(ValueError, match="reference COLMAP model"):
        evaluate_run(run_dir, None, tmp_path / "scan_alignment.mlp", 0.02, tmp_path / "evaluator")


def test_proxy_evaluation_requires_reference_model(tmp_path: Path) -> None:
    run_dir = _run_dir_with_cloud(tmp_path)
    ground_truth = tmp_path / "scan.ply"
    _write_ply_xyz(ground_truth, np.asarray([[1.0, 2, 3]]))

    with pytest.raises(ValueError, match="reference COLMAP model"):
        evaluate_run(run_dir, None, ground_truth, 0.02)


def test_evaluation_composes_artifact_and_pose_transforms(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run_dir = _run_dir_with_cloud(tmp_path)
    mapping = {f"{index}.jpg": f"folder/{index}.jpg" for index in range(3)}
    (run_dir / "photometric_split.json").write_text(json.dumps({"image_to_source_id": mapping}), encoding="utf-8")
    transform = np.eye(4)
    transform[:3, 3] = [2, 0, 0]
    (run_dir / "geometry_frames.json").write_text(
        json.dumps(
            {
                "colmap_to_trainer": np.linalg.inv(transform).tolist(),
                "trainer_to_colmap": transform.tolist(),
                "artifacts": {"dense/fused.ply": "trainer"},
            }
        ),
        encoding="utf-8",
    )

    def image(name: str) -> SimpleNamespace:
        return SimpleNamespace(
            name=name,
            projection_center=lambda: np.zeros(3),
            cam_from_world=lambda: SimpleNamespace(rotation=SimpleNamespace(matrix=lambda: np.eye(3))),
        )

    def reconstruction(path: Path) -> SimpleNamespace:
        names = mapping if path == run_dir / "sparse" else mapping.values()
        return SimpleNamespace(images={index: image(name) for index, name in enumerate(names)})

    monkeypatch.setitem(sys.modules, "pycolmap", SimpleNamespace(Reconstruction=reconstruction))
    monkeypatch.setattr("rescene.evaluation.pose_errors", lambda *args: (0, 0, (2, np.eye(3), np.array([0, 3, 0]))))
    evaluator = tmp_path / "evaluator"
    evaluator.write_text("binary", encoding="utf-8")
    monkeypatch.setattr("rescene.evaluation._official_point_scores", lambda *args: (0.25, 0.5, 0.75))

    metrics = evaluate_run(run_dir, tmp_path / "reference", tmp_path / "scan.mlp", 0.02, evaluator)

    assert metrics["evaluation_point_cloud_frame"] == "trainer"
    assert np.allclose(_read_ply_xyz(run_dir / "evaluation" / "aligned-reconstruction.ply"), [[6, 7, 6]])
    evidence = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))["evaluation_evidence"]
    assert evidence["schema_version"] == 1
    assert evidence["fields"]["point_fscore"] == 0.75
    assert evidence["fields"]["official_evaluator_sha256"]
    assert set(evidence["artifacts"]) == {"scene_spz_sha256", "final_ply_sha256", "dense_ply_sha256"}
    assert evidence["artifacts"]["dense_ply_sha256"]


def test_evaluation_rejects_missing_coordinate_metadata(tmp_path: Path) -> None:
    from rescene.coordinate_frames import artifact_to_colmap

    run_dir = _run_dir_with_cloud(tmp_path)
    with pytest.raises(FileNotFoundError, match="Coordinate frame metadata"):
        artifact_to_colmap(run_dir, run_dir / "dense" / "fused.ply")
