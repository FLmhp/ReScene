import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from PIL import Image

from rescene.colmap_runner import run
from scripts import supervise_route_experiments as supervisor
from scripts.export_experimental_geometry import export_geometry, reprojection_errors
from scripts.freeze_manyview import freeze
from scripts.route_experiments_v3 import archive_trial, frozen_inputs, summarize, validation_sources, verify_selection


def test_frozen_inputs_and_validation_reject_changed_or_dropped_sources(tmp_path):
    (tmp_path / "00.jpg").write_bytes(b"fixture")
    hashes = frozen_inputs({}, tmp_path)
    with pytest.raises(ValueError, match="unique"):
        validation_sources(tmp_path, {"sources": [0, 0]})
    (tmp_path / "00.jpg").write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        frozen_inputs({"source_sha256": hashes}, tmp_path)
    with pytest.raises(ValueError, match="selected sources"):
        verify_selection(
            {"selected_sources": ["a", "b", "c"]},
            {"train_source_ids": ["b"], "validation_source_ids": ["a"]},
            {"a"},
        )


def test_supervisor_enforces_budget_and_continues_after_model_failure(tmp_path, monkeypatch):
    gib = 1024**3
    trial = {"profile": "quality", "expected_write_bytes": 10 * gib, "wall_estimate_seconds": 30}
    assert supervisor.trial_requirement(trial, None, 12 * gib, 10) == "insufficient_disk"
    assert supervisor.trial_requirement(trial, 40, 13 * gib, 10) == "insufficient_time"
    assert supervisor.trial_requirement(trial, 41, 13 * gib, 10) is None
    with monkeypatch.context() as isolated:
        isolated.setenv("RESCENE_EXPERIMENT_ARCHIVE", str(tmp_path / "archive"))
        with pytest.raises(RuntimeError, match="mounted /root/autodl-fs"):
            supervisor.require_archive_mount()
    (tmp_path / "plan-status").mkdir()
    monkeypatch.setattr(supervisor, "RUNS", tmp_path)
    monkeypatch.setattr(supervisor, "free_bytes", lambda: 20 * gib)
    monitor = Mock(side_effect=[{"valid": False, "trial_failure": "algorithm"}, {"valid": True}])
    monkeypatch.setattr(supervisor, "monitor", monitor)
    plan = [{**trial, "name": name, "spec": "specs/test.json"} for name in ("r1", "r2")]
    assert supervisor.locked(plan) == 1 and monitor.call_count == 2
    status = json.loads((tmp_path / "plan-status" / "specs-r1.json").read_text())
    assert status["trials"]["r2"] == "valid"


def test_monitor_signals_only_the_trial_on_deadline(tmp_path, monkeypatch):
    spec = tmp_path / "trial.json"
    spec.write_text("{}")
    (tmp_path / "resources").mkdir()
    monkeypatch.setattr(supervisor, "RUNS", tmp_path)
    monkeypatch.setattr(supervisor, "ROOT", tmp_path)
    proc = Mock(pid=12345, returncode=-15)
    proc.poll.side_effect = [None, -15]
    proc.wait.return_value = -15
    monkeypatch.setattr(supervisor.subprocess, "Popen", Mock(return_value=proc))
    monkeypatch.setattr(supervisor, "gpu_processes", lambda: {})
    monkeypatch.setattr(supervisor, "environment", dict)
    terminate = Mock()
    monkeypatch.setattr(supervisor.os, "killpg", terminate, raising=False)
    result = supervisor.monitor({"name": "test", "profile": "fast", "spec": spec, "repeat": 1}, deadline=0)
    terminate.assert_called_once_with(12345, supervisor.signal.SIGTERM)
    assert not result["valid"] and result["abort_reason"] == "batch deadline reached"


def test_freeze_nested_subsets_keep_the_same_validation_views(tmp_path):
    scene = tmp_path / "scene"
    scene.mkdir()
    for index in range(12):
        data = np.random.default_rng(index).integers(20, 236, (64, 64, 3), dtype=np.uint8)
        Image.fromarray(data).save(scene / f"{index:03d}.jpg")
    result = freeze(scene, tmp_path / "frozen", [4, 8, 12], validation_count=2)
    used = set()
    for size in (4, 8, 12):
        spec = result["subsets"][str(size)]
        selected = set(spec["selected_sources"])
        directory = Path(spec["scene"])
        assert used < selected and len(selected) == size
        assert frozen_inputs(spec, directory) == spec["source_sha256"]
        assert validation_sources(directory, spec["validation"]) == set(result["validation_source_ids"])
        used = selected


def test_archived_trial_cannot_be_reused_after_corruption(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    metrics = run_dir / "metrics.json"
    metrics.write_text("{}")
    archive = tmp_path / "archive"
    verdict = {"valid": True}
    archive_trial(run_dir, archive, "id", verdict, False)
    archive_trial(run_dir, archive, "id", verdict, False)
    (archive / "run" / "metrics.json").write_text("bad")
    with pytest.raises(ValueError, match="Existing archive"):
        archive_trial(run_dir, archive, "id", verdict, False)
    assert metrics.read_text() == "{}"


def test_summary_records_a_failure_without_metrics(tmp_path):
    resources = tmp_path / "resources"
    resources.mkdir()
    (resources / "failed.json").write_text('{"valid": false, "trial_failure": "algorithm"}')
    output = tmp_path / "summary.json"
    summarize(tmp_path / "runs", resources, output)
    result = json.loads(output.read_text())
    assert result["failures"] == [{"run": "failed", "reason": "algorithm", "validation": {"valid": False}}]


def test_global_colmap_uses_a_private_copy_and_never_runs_incremental_fallback(tmp_path, monkeypatch):
    original = tmp_path / "matching.db"
    original.write_bytes(b"closed database")
    scene = tmp_path / "scene"
    scene.mkdir()
    model = Mock()
    model.num_reg_images.return_value = 3
    mapper = Mock(return_value={0: model})
    colmap = SimpleNamespace(
        ImageReaderOptions=SimpleNamespace,
        global_mapping=mapper,
        bundle_adjustment=Mock(),
        incremental_mapping=Mock(),
        extract_features=Mock(),
        set_random_seed=Mock(),
    )
    monkeypatch.setitem(sys.modules, "pycolmap", colmap)
    run(scene, "exhaustive", False, mapper="global", matching_db=original, seed=43)
    mapper.assert_called_once_with(scene / "database.db", scene / "images", scene / "sparse-work")
    colmap.set_random_seed.assert_called_once_with(43)
    colmap.incremental_mapping.assert_not_called()
    colmap.extract_features.assert_not_called()
    assert (scene / "database.db").read_bytes() == original.read_bytes()


def test_experimental_pose_projection_rejects_reflections_and_accepts_valid_pose():
    intrinsics = np.array([[100, 0, 32], [0, 100, 32], [0, 0, 1]])
    points = np.array([[-0.1, -0.1, 2], [0.1, -0.1, 2], [-0.1, 0.1, 2], [0.1, 0.1, 2]])
    pose = np.eye(4)
    pose[0, 3] = 0.2
    pixels = (points[:, :2] + [0.2, 0]) * 50 + 32
    assert np.max(reprojection_errors(intrinsics, pose, points, pixels)) < 1e-8
    pose[0, 0] = -1
    with pytest.raises(ValueError, match="proper rigid"):
        reprojection_errors(intrinsics, pose, points, pixels)


def test_experimental_geometry_reloads_in_real_pycolmap(tmp_path: Path):
    pytest.importorskip("pycolmap")
    images = tmp_path / "images"
    images.mkdir()
    names = ["000000.jpg", "000001.jpg"]
    for name in names:
        Image.new("RGB", (64, 64)).save(images / name)
    intrinsics = np.array([[100, 0, 32], [0, 100, 32], [0, 0, 1]])
    points = np.array([[-0.1, -0.1, 2], [0.1, -0.1, 2], [-0.1, 0.1, 2], [0.1, 0.1, 2]])
    poses = np.repeat(np.eye(4)[None], 2, axis=0)
    poses[1, 0, 3] = 0.2
    predictions = tmp_path / "prediction.npz"
    np.savez(
        predictions,
        image_names=names,
        intrinsics=np.repeat(intrinsics[None], 2, axis=0),
        cam_from_world=poses,
        points=np.tile(points, (2, 1)),
        colors=np.full((8, 3), 128, dtype=np.uint8),
        image_indices=[0] * 4 + [1] * 4,
        pixels=np.vstack((points[:, :2] * 50 + 32, (points[:, :2] + [0.2, 0]) * 50 + 32)),
    )
    result = export_geometry(predictions, tmp_path)
    assert result["registered"] == 2 and result["points"] == 8


def test_global_mapping_reconstructs_a_synthetic_database_on_cpu(tmp_path: Path):
    colmap = pytest.importorskip("pycolmap")
    path = tmp_path / "matches.db"
    database = colmap.Database.open(path)
    colmap.set_random_seed(42)
    try:
        expected = colmap.synthesize_dataset(
            colmap.SyntheticDatasetOptions(
                num_rigs=1,
                num_frames_per_rig=6,
                num_points3D=80,
                camera_has_prior_focal_length=True,
                two_view_geometry_has_relative_pose=True,
            ),
            database,
        )
    finally:
        database.close()
    scene = tmp_path / "scene"
    (scene / "images").mkdir(parents=True)
    for image in expected.images.values():
        Image.new("RGB", (1024, 768)).save(scene / "images" / image.name)
    run(scene, "exhaustive", False, mapper="global", matching_db=path, seed=42)
    result = colmap.Reconstruction(scene / "sparse" / "0")
    assert result.num_reg_images() == 6 and result.num_points3D() == 80
