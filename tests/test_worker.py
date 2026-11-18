import hashlib
import json
import shutil
import tarfile
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from PIL import Image

from rescene_worker.main import (
    Api,
    IncompleteCheckpoint,
    InvalidInput,
    archive_stage,
    artifacts,
    download_inputs,
    is_resumed_stage,
    restore_archive,
    safe_cleanup,
    stage_progress,
)


def test_publication_uses_declared_final_ply_not_largest_or_lexical_file(tmp_path, monkeypatch):
    (tmp_path / "config.json").write_text(json.dumps({"gsplat_steps": 7000}), encoding="utf-8")
    output = tmp_path / "gsplat"
    ply_dir = output / "ply"
    ply_dir.mkdir(parents=True)
    (output / "run.json").write_text(json.dumps({"ply_step": 6999, "eval_step": 6999}), encoding="utf-8")
    final = b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n1\n"
    (ply_dir / "point_cloud_6999.ply").write_bytes(final)
    (ply_dir / "point_cloud_699.ply").write_bytes(final * 4)
    (ply_dir / "point_cloud_9999.ply").write_bytes(final * 8)
    for name in ("scene.spz", "metrics.json", "report.md"):
        (tmp_path / name).write_bytes(b"fixture")
    uploaded = {}

    class Bucket:
        def put_object_from_file(self, key, filename, **kwargs):
            uploaded[key] = Path(filename).read_bytes()

    monkeypatch.setattr(
        "rescene_worker.main.oss2.resumable_upload",
        lambda bucket, key, filename, **kwargs: bucket.put_object_from_file(key, filename),
    )
    published = artifacts(tmp_path, Bucket(), "projects/p/jobs/j/")
    record = next(item for item in published if item["kind"] == "ply")
    assert uploaded[record["object_key"]] == final
    assert record["sha256"] == hashlib.sha256(final).hexdigest()
    assert record["size"] == len(final)
    manifest = json.loads(uploaded["projects/p/jobs/j/artifacts/manifest/manifest.json"])
    assert next(item for item in manifest["artifacts"] if item["kind"] == "ply") == record


def test_stage_progress_is_bounded():
    assert stage_progress("geometry", "running") == pytest.approx(0.4)
    assert stage_progress("geometry", "success") == pytest.approx(0.5)
    assert 0 <= stage_progress("unknown", "running") <= 1


def test_worker_api_retries_invalid_gateway_response(monkeypatch):
    config = type("Config", (), {"api_url": "https://api.example", "token": "token", "worker_id": "worker"})()
    bad, good = MagicMock(), MagicMock()
    bad.__enter__.return_value.read.return_value = b"not-json"
    good.__enter__.return_value.read.return_value = b'{"job":null}'
    monkeypatch.setattr("rescene_worker.main.urllib.request.urlopen", Mock(side_effect=[bad, good]))
    monkeypatch.setattr("rescene_worker.main.time.sleep", lambda _seconds: None)
    monkeypatch.setattr("rescene_worker.main.gpu_name", lambda: "GPU")

    assert Api(config).post("/lease") == {"job": None}


def test_resumed_stage_is_not_archived_again():
    job = {"resume_artifact_key": "projects/p/jobs/j/checkpoints/preprocess.tar.gz"}

    assert is_resumed_stage(job, "preprocess")
    assert not is_resumed_stage(job, "geometry")


@pytest.mark.parametrize("filename", ["a.png", "wechat-temp.jpg"])
def test_download_checks_bytes_and_preserves_duplicate_basenames(tmp_path, monkeypatch, filename):
    # The 8 GiB headroom guard must not make this test depend on the runner's disk.
    monkeypatch.setattr(shutil, "disk_usage", lambda _path: SimpleNamespace(free=10**12))
    source = tmp_path / "source"
    source.mkdir()
    original = source / "a.png"
    Image.new("RGB", (8, 8)).save(original)
    content = original.read_bytes()
    bucket = Mock()
    bucket.get_object_to_file.side_effect = lambda _key, path: Path(path).write_bytes(content)
    assets = [
        {
            "id": str(index),
            "filename": filename,
            "object_key": str(index),
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        for index in range(2)
    ]
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    assert download_inputs(bucket, assets, inputs, (Event(), Event())) == inputs
    assert len(list(inputs.glob("*.png"))) == 2
    assert not list(inputs.glob("*.jpg"))
    assets[0]["sha256"] = hashlib.sha256(bytes(len(content))).hexdigest()
    with pytest.raises(InvalidInput, match="integrity"):
        download_inputs(bucket, assets, inputs, (Event(), Event()))


def test_safe_cleanup_rejects_work_root(tmp_path):
    with pytest.raises(RuntimeError, match="unsafe path"):
        safe_cleanup(tmp_path, tmp_path)


def test_cancel_signals_only_the_spawned_process_group(monkeypatch):
    import os
    import signal

    from rescene_worker.main import terminate_job_group

    kill_group = Mock()
    monkeypatch.setattr(os, "killpg", kill_group, raising=False)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    process = Mock(pid=42)
    terminate_job_group(process)
    assert kill_group.call_args_list[0].args == (42, signal.SIGTERM)
    assert kill_group.call_args_list[1].args[0] == 42


def test_safe_cleanup_removes_only_child(tmp_path):
    child = tmp_path / "job"
    child.mkdir()
    (child / "result.txt").write_text("ok", encoding="utf-8")
    safe_cleanup(child, tmp_path)
    assert not child.exists()
    assert Path(tmp_path).exists()


def test_restore_rejects_symlinks(tmp_path):
    source = tmp_path / "source.tar.gz"
    with tarfile.open(source, "w:gz") as archive:
        member = tarfile.TarInfo("escape")
        member.type = tarfile.SYMTYPE
        member.linkname = "../../outside"
        archive.addfile(member)
    bucket = Mock()
    bucket.get_object_to_file.side_effect = lambda _key, destination: Path(destination).write_bytes(source.read_bytes())

    with pytest.raises(RuntimeError, match="Unsafe archive member type"):
        restore_archive(bucket, "resume", tmp_path / "output")


@pytest.mark.parametrize("stage,has_selection", [("geometry", True), ("geometry", False), ("training", True)])
def test_checkpoint_preserves_photometric_selection_and_rebases_images(tmp_path, monkeypatch, stage, has_selection):
    output = tmp_path / "output"
    (output / "stages").mkdir(parents=True)
    for completed in ("preprocess", "geometry", "training"):
        (output / "stages" / f"{completed}.json").write_text('{"status":"success"}', encoding="utf-8")
    (output / "images").mkdir()
    image = output / "images" / "000001.jpg"
    image.write_bytes(b"fixture")
    (output / "input_manifest.json").write_text(
        json.dumps({"frames": [{"file": str(image), "selected": True, "source_id": "test"}]}), encoding="utf-8"
    )
    for provenance in ("photometric_split.json", "geometry_frames.json"):
        (output / provenance).write_text("{}", encoding="utf-8")
    if has_selection:
        (output / "photometric_selection.json").write_text("{}", encoding="utf-8")
    stored = tmp_path / "stored.tar.gz"
    monkeypatch.setattr("oss2.resumable_upload", lambda _bucket, _key, path, **_kw: shutil.copyfile(path, stored))
    bucket = Mock()
    bucket.get_object_to_file.side_effect = lambda _key, destination: shutil.copyfile(stored, destination)
    key = archive_stage(bucket, output, "job/", stage)
    restored = tmp_path / "restored"
    if has_selection:
        restore_archive(bucket, key, restored)
        assert (restored / "photometric_selection.json").read_text(encoding="utf-8") == "{}"
        manifest = json.loads((restored / "input_manifest.json").read_text(encoding="utf-8"))
        assert manifest["frames"][0]["file"] == str(restored / "images" / image.name)
        if stage == "training":
            assert (restored / "geometry_frames.json").is_file()
    else:
        with pytest.raises(IncompleteCheckpoint, match="photometric selection"):
            restore_archive(bucket, key, restored)


def test_log_shipper_tails_incrementally(tmp_path):
    from rescene_worker.logs import LogShipper

    log_path = tmp_path / "worker.log"
    stage_dir = tmp_path / "logs"
    stage_dir.mkdir()
    log_path.write_text("", encoding="utf-8")

    shipped: list[tuple[str, dict]] = []

    class Recorder:
        def post(self, path, payload=None):
            shipped.append((path, payload))
            return {}

    shipper = LogShipper(Recorder(), "/v1/worker/jobs/j1", 2, lambda: [log_path, *sorted(stage_dir.glob("*.log"))])

    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("colmap started\nsparse warning\nhalf")
    assert shipper.drain() == [
        {"level": "info", "message": "colmap started"},
        {"level": "warning", "message": "sparse warning"},
    ]

    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("-line done\n\nTraceback: boom\n")
    assert shipper.drain() == [
        {"level": "info", "message": "half-line done"},
        {"level": "error", "message": "Traceback: boom"},
    ]
    assert shipper.drain() == []

    (stage_dir / "gsplat.log").write_text("gsplat iters 1\n", encoding="utf-8")
    assert shipper.drain() == [{"level": "info", "message": "gsplat iters 1"}]

    log_path.write_text("truncated\n", encoding="utf-8")
    assert shipper.drain() == [{"level": "info", "message": "truncated"}]

    log_path.write_text("y" * 5000 + "\n", encoding="utf-8")
    assert [len(line["message"]) for line in shipper.drain()] == [4000]

    shipper.ship([{"level": "info", "message": f"line {index}"} for index in range(450)])
    assert [len(payload["lines"]) for _, payload in shipped] == [200, 200, 50]
    assert shipped[0][0] == "/v1/worker/jobs/j1/logs"
    assert shipped[0][1]["attempt"] == 2

    class Broken:
        def post(self, path, payload=None):
            raise OSError("api down")

    LogShipper(Broken(), "/v1/worker/jobs/j1", 1, lambda: [log_path]).ship([{"level": "info", "message": "x"}])

    flushed: list[str] = []

    class Collector:
        def post(self, path, payload=None):
            flushed.extend(line["message"] for line in payload["lines"])
            return {}

    log_path.write_text("final words\n", encoding="utf-8")
    flusher = LogShipper(Collector(), "/v1/worker/jobs/j1", 1, lambda: [log_path], interval=30.0)
    flusher.start()
    flusher.stop()
    assert flushed == ["final words"]
