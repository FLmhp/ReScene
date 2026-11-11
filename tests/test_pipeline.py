import json

import pytest

from rescene import pipeline
from rescene.pipeline import _clear_colmap_outputs, _run_dir_has_results, _sparse_has_points


def test_launcher_files_do_not_make_a_run_existing(tmp_path):
    (tmp_path / "launcher.log").touch()
    (tmp_path / "pid").write_text("123", encoding="utf-8")
    assert not _run_dir_has_results(tmp_path)

    (tmp_path / "stages").mkdir()
    assert _run_dir_has_results(tmp_path)


def test_sparse_points_validation(tmp_path):
    sparse = tmp_path / "sparse" / "0"
    sparse.mkdir(parents=True)
    points = sparse / "points3D.bin"
    points.write_bytes(b"\0" * 8)
    assert not _sparse_has_points(tmp_path)
    points.write_bytes(b"\0" * 9)
    assert _sparse_has_points(tmp_path)


def test_colmap_retry_cleanup_stays_inside_run(tmp_path):
    (tmp_path / "database.db").touch()
    (tmp_path / "sparse").mkdir()
    (tmp_path / "dense").mkdir()
    keep = tmp_path / "images"
    keep.mkdir()
    _clear_colmap_outputs(tmp_path)
    assert not (tmp_path / "database.db").exists()
    assert not (tmp_path / "sparse").exists()
    assert not (tmp_path / "dense").exists()
    assert keep.exists()


def test_sparse_colmap_fallback_disables_dense(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        pipeline,
        "colmap_command",
        lambda run_dir, *, sequential, dense, camera_model, mvs_max_image_size, poisson_depth: [
            str(sequential),
            str(dense),
            camera_model,
            str(mvs_max_image_size),
            str(poisson_depth),
        ],
    )
    monkeypatch.setattr(pipeline, "run_command", lambda command, log_path, *, cwd: calls.append(command))
    pipeline._run_sparse_colmap(
        tmp_path,
        tmp_path / "run",
        tmp_path / "geometry.log",
        sequential=True,
        camera_model="SIMPLE_RADIAL",
        mvs_max_image_size=1200,
        poisson_depth=12,
    )
    assert calls == [["True", "False", "SIMPLE_RADIAL", "1200", "12"]]


def _source_run(tmp_path):
    source = tmp_path / "source"
    (source / "images").mkdir(parents=True)
    (source / "images" / "000000.jpg").write_bytes(b"image")
    (source / "sparse" / "0").mkdir(parents=True)
    (source / "sparse" / "0" / "points3D.bin").write_bytes(b"0123456789")
    (source / "input_manifest.json").write_text(
        json.dumps(
            {"frames": [{"selected": True, "file": str(source / "images" / "000000.jpg"), "source_id": "a.jpg"}]}
        ),
        encoding="utf-8",
    )
    (source / "photometric_selection.json").write_text("{}", encoding="utf-8")
    (source / "stages").mkdir()
    for name in ("preprocess", "geometry"):
        (source / "stages" / f"{name}.json").write_text('{"status":"success"}', encoding="utf-8")
    return source


def test_reuse_bundle_hashes_and_tampering(tmp_path):
    source = _source_run(tmp_path)
    bundle = tmp_path / "bundle"
    digest = pipeline.create_reuse_bundle(source, bundle)
    assert pipeline._verify_reuse_bundle(bundle, digest)["source_run"] == str(source)
    with pytest.raises(FileExistsError):
        pipeline.create_reuse_bundle(source, bundle)
    (bundle / "images" / "000000.jpg").write_bytes(b"modified")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        pipeline._verify_reuse_bundle(bundle, digest)
    assert (source / "images" / "000000.jpg").read_bytes() == b"image"


def test_reuse_manifest_digest_and_extra_files_are_checked(tmp_path):
    source = _source_run(tmp_path)
    bundle = tmp_path / "bundle"
    digest = pipeline.create_reuse_bundle(source, bundle)
    with pytest.raises(ValueError, match="manifest SHA-256"):
        pipeline._verify_reuse_bundle(bundle, "0" * 64)
    (bundle / "sparse" / "extra.bin").write_bytes(b"extra")
    with pytest.raises(ValueError, match="artifact SHA-256"):
        pipeline._verify_reuse_bundle(bundle, digest)


@pytest.mark.parametrize("stage", ["training", "dense"])
def test_reuse_runs_only_requested_stage_and_is_not_cold_total(tmp_path, monkeypatch, stage):
    source = _source_run(tmp_path)
    bundle = tmp_path / "bundle"
    digest = pipeline.create_reuse_bundle(source, bundle)
    output = tmp_path / "output"
    calls = []
    monkeypatch.setattr(pipeline, "_environment", lambda root: {})
    monkeypatch.setattr(pipeline, "run_command", lambda command, log_path, *, cwd: calls.append(command))
    monkeypatch.setattr(pipeline, "collect_metrics", lambda run_dir: {"total_seconds": 123})
    monkeypatch.setattr(pipeline, "write_report", lambda run_dir, metrics: None)
    pipeline.run_pipeline(
        "balanced", source, "comparison", output_dir=output, reuse_bundle=bundle, reuse_sha256=digest, reuse_stage=stage
    )
    assert len(calls) == 1
    assert ("--dense-only" in calls[0]) == (stage == "dense")
    metrics = json.loads((output / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["total_seconds"] is None
    assert metrics["reuse"]["manifest_sha256"] == digest
    assert set(metrics["timings"]) == {"reuse_prepare", stage}
    copied = json.loads((output / "input_manifest.json").read_text(encoding="utf-8"))
    assert copied["frames"][0]["file"] == str(output / "images" / "000000.jpg")
    assert json.loads((source / "input_manifest.json").read_text(encoding="utf-8"))["frames"][0]["file"] == str(
        source / "images" / "000000.jpg"
    )
    with pytest.raises(FileExistsError):
        pipeline.run_pipeline(
            "balanced",
            source,
            "comparison",
            output_dir=output,
            reuse_bundle=bundle,
            reuse_sha256=digest,
            reuse_stage=stage,
        )


def test_report_preserves_reuse_timing_and_provenance(tmp_path, monkeypatch):
    run = tmp_path / "runs" / "comparison"
    run.mkdir(parents=True)
    (run / "reuse_provenance.json").write_text('{"mode":"single_stage_reuse"}', encoding="utf-8")
    (run / "metrics.json").write_text('{"timings":{"training":1.5}}', encoding="utf-8")
    monkeypatch.setattr(pipeline, "project_root", lambda: tmp_path)
    monkeypatch.setattr(pipeline, "collect_metrics", lambda *args: {"total_seconds": 1.5})
    monkeypatch.setattr(pipeline, "write_report", lambda run_dir, metrics: run_dir / "report.md")
    pipeline.report_run("comparison")
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["total_seconds"] is None
    assert metrics["timings"] == {"training": 1.5}
    assert metrics["reuse"]["mode"] == "single_stage_reuse"


def test_reuse_forbids_overlap_and_resume(tmp_path):
    source = _source_run(tmp_path)
    with pytest.raises(ValueError, match="separate"):
        pipeline.create_reuse_bundle(source, source / "bundle")
    bundle = tmp_path / "bundle"
    digest = pipeline.create_reuse_bundle(source, bundle)
    with pytest.raises(ValueError, match="no resume"):
        pipeline.run_pipeline(
            "balanced",
            source,
            "r",
            output_dir=tmp_path / "output",
            resume=True,
            reuse_bundle=bundle,
            reuse_sha256=digest,
            reuse_stage="dense",
        )
    with pytest.raises(ValueError, match="separate"):
        pipeline.run_pipeline(
            "balanced",
            source,
            "r",
            output_dir=source / "output",
            reuse_bundle=bundle,
            reuse_sha256=digest,
            reuse_stage="dense",
        )
