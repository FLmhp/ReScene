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


@pytest.mark.parametrize(("queries", "points", "attempts"), [(8, 1024, 2), (16, 2048, 1)])
def test_balanced_retries_only_when_the_budget_changes(tmp_path, monkeypatch, queries, points, attempts):
    source = tmp_path / "input"
    source.mkdir()
    (source / "frame.jpg").touch()
    output = tmp_path / "output"
    monkeypatch.setattr(pipeline, "_environment", lambda root: {})
    monkeypatch.setattr(
        pipeline,
        "preprocess_input",
        lambda path, dest, **kwargs: (dest / "input_manifest.json").write_text('{"settings":{"seed":42}}'),
    )
    calls = []

    def no_model(command, log, *, cwd):
        calls.append(log.name)
        raise RuntimeError("No reconstruction can be built with BA")

    def colmap(*args, **kwargs):
        raise RuntimeError("entered COLMAP fallback")

    monkeypatch.setattr(pipeline, "run_command", no_model)
    monkeypatch.setattr(pipeline, "_run_sparse_colmap", colmap)
    config = pipeline.profile_config("balanced").with_overrides(
        {"vggt_query_frames": queries, "vggt_max_query_points": points}
    )
    with pytest.raises(RuntimeError, match="entered COLMAP"):
        pipeline.run_pipeline("balanced", source, "test", config_override=config, output_dir=output)
    assert calls == ["geometry.log", "geometry-retry.log"][:attempts]
    assert json.loads((output / "degradation.json").read_text())["reason"] == "ba_failed+colmap_sparse"


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
    manifest_path = source / "input_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["settings"] = {"seed": 43}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
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
    if stage == "training":
        assert calls[0][calls[0].index("--seed") + 1] == "43"
        assert metrics["reuse"]["training_seed"] == 43
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


def test_report_reuses_evaluation_only_for_unchanged_artifacts(tmp_path, monkeypatch):
    from rescene.metrics import evaluation_artifacts

    run = tmp_path / "runs" / "eval"
    run.mkdir(parents=True)
    (run / "scene.spz").write_bytes(b"scene")
    (run / "metrics.json").write_text(
        json.dumps(
            {
                "timings": {"training": 2.0},
                "pose_ate": 0.25,
                "point_fscore": 0.9,
                "evaluation_evidence": {
                    "schema_version": 1,
                    "artifacts": evaluation_artifacts(run),
                    "fields": {"pose_ate": 0.25, "point_fscore": 0.9},
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(pipeline, "project_root", lambda: tmp_path)
    monkeypatch.setattr(pipeline, "collect_metrics", lambda *args: {"total_seconds": 9.0})
    monkeypatch.setattr(pipeline, "write_report", lambda run_dir, metrics: run_dir / "report.md")

    pipeline.report_run("eval")
    pipeline.report_run("eval")
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["pose_ate"] == 0.25
    assert metrics["point_fscore"] == 0.9
    assert metrics["timings"] == {"training": 2.0}
    assert "evaluation_needs_recompute" not in metrics

    (run / "scene.spz").write_bytes(b"regenerated")
    pipeline.report_run("eval")
    stale = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert "pose_ate" not in stale
    assert "point_fscore" not in stale
    assert stale["evaluation_needs_recompute"] is True
    assert stale["timings"] == {"training": 2.0}


def _completed_resume_run(tmp_path):
    run = tmp_path / "runs" / "resume"
    run.mkdir(parents=True)
    (run / "scene.spz").write_bytes(b"scene")
    (run / "stages").mkdir()
    for name in ("preprocess", "geometry", "training", "export"):
        (run / "stages" / f"{name}.json").write_text('{"status":"success"}', encoding="utf-8")
    (run / "input_manifest.json").write_text(
        json.dumps({"settings": {"seed": 42}, "counts": {}, "frames": []}), encoding="utf-8"
    )
    (run / "images").mkdir()
    (run / "images" / "000000.jpg").write_bytes(b"image")
    (run / "photometric_selection.json").write_text("{}", encoding="utf-8")
    (run / "sparse" / "0").mkdir(parents=True)
    (run / "sparse" / "0" / "points3D.bin").write_bytes(b"\0" * 9)
    (run / "gsplat").mkdir()
    (run / "gsplat" / "photometric_views.json").write_text("{}", encoding="utf-8")
    (run / "gsplat" / "run.json").write_text("{}", encoding="utf-8")
    for name in ("photometric_split.json", "geometry_frames.json"):
        (run / name).write_text("{}", encoding="utf-8")
    return run


def test_resume_preserves_timings_and_evaluation_evidence(tmp_path, monkeypatch):
    from rescene.metrics import evaluation_artifacts

    run = _completed_resume_run(tmp_path)
    evidence = {
        "schema_version": 1,
        "artifacts": evaluation_artifacts(run),
        "fields": {"pose_ate": 0.25, "point_fscore": 0.9},
    }
    (run / "metrics.json").write_text(
        json.dumps(
            {
                "timings": {"preprocess": 3.0, "training": 12.0},
                "pose_ate": 0.25,
                "point_fscore": 0.9,
                "evaluation_evidence": evidence,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(pipeline, "_environment", lambda root: {})
    monkeypatch.setattr(pipeline, "collect_metrics", lambda *args: {"total_seconds": 5.0})

    pipeline.run_pipeline("balanced", tmp_path / "input", "resume", resume=True, output_dir=run)
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["pose_ate"] == 0.25
    assert metrics["point_fscore"] == 0.9
    assert "evaluation_needs_recompute" not in metrics
    assert metrics["timings"]["preprocess"] == 3.0
    assert metrics["timings"]["training"] == 12.0
    assert "evaluation" in metrics["timings"]

    (run / "scene.spz").write_bytes(b"regenerated")
    pipeline.run_pipeline("balanced", tmp_path / "input", "resume", resume=True, output_dir=run)
    stale = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert "pose_ate" not in stale
    assert "point_fscore" not in stale
    assert stale["evaluation_needs_recompute"] is True
    assert stale["timings"]["preprocess"] == 3.0


def test_resume_uses_recorded_training_oom_fallback(tmp_path, monkeypatch):
    run = tmp_path / "run"
    (run / "stages").mkdir(parents=True)
    (run / "stages" / "preprocess.json").write_text('{"status":"success"}', encoding="utf-8")
    (run / "stages" / "geometry.json").write_text('{"status":"success"}', encoding="utf-8")
    (run / "input_manifest.json").write_text(
        json.dumps({"settings": {"seed": 42}, "counts": {}, "frames": []}), encoding="utf-8"
    )
    (run / "images").mkdir()
    (run / "photometric_selection.json").write_text("{}", encoding="utf-8")
    (run / "sparse" / "0").mkdir(parents=True)
    (run / "sparse" / "0" / "points3D.bin").write_bytes(b"\0" * 9)
    config = pipeline.profile_config("balanced")
    fallback = config.degraded()
    (run / "degradation.json").write_text(
        json.dumps({"stage": "training", "reason": "cuda_oom", "config": fallback.to_dict()}),
        encoding="utf-8",
    )
    trained = []

    def gsplat(_root, _scene, _output, effective, *, seed):
        trained.append(effective)
        return ["gsplat"]

    monkeypatch.setattr(pipeline, "gsplat_command", gsplat)
    monkeypatch.setattr(pipeline, "run_command", lambda command, log_path, *, cwd: None)
    monkeypatch.setattr(pipeline, "_ensure_downsampled_images", lambda *args, **kwargs: None)
    monkeypatch.setattr(pipeline, "_find_ply", lambda run_dir: run_dir / "unused.ply")
    monkeypatch.setattr(pipeline, "_environment", lambda root: {})
    monkeypatch.setattr(
        pipeline,
        "collect_metrics",
        lambda run_dir, degraded=None: {"total_seconds": 1.0, "degraded": degraded},
    )
    monkeypatch.setattr(pipeline, "write_report", lambda *args: None)

    pipeline.run_pipeline("balanced", tmp_path / "input", "oom", resume=True, output_dir=run)

    assert len(trained) == 1
    assert trained[0] == fallback
    assert trained[0].gsplat_data_factor == config.gsplat_data_factor * 2
    assert trained[0].gsplat_packed
    assert trained[0].max_frames == config.max_frames // 2
    degradation = json.loads((run / "degradation.json").read_text(encoding="utf-8"))
    assert degradation["effective"] is True
    assert degradation["config"] == fallback.to_dict()
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["degraded"]["stage"] == "training"


def test_recorded_training_fallback_accepts_repeated_degradation():
    config = pipeline.profile_config("balanced")
    twice = config.degraded().degraded()

    assert pipeline._recorded_training_fallback(config, {"stage": "training", "config": twice.to_dict()}) == twice
    assert pipeline._recorded_training_fallback(config, {"stage": "geometry", "config": twice.to_dict()}) is None
    assert (
        pipeline._recorded_training_fallback(
            config, {"stage": "training", "config": {**twice.to_dict(), "geometry_backend": "colmap"}}
        )
        is None
    )
    assert pipeline._recorded_training_fallback(config, {"stage": "training", "config": config.to_dict()}) is None
    assert pipeline._recorded_training_fallback(config, {"stage": "training", "config": {}}) is None


def _failing_geometry_run(tmp_path, monkeypatch, failure):
    source = tmp_path / "input"
    source.mkdir()
    (source / "frame.jpg").touch()
    output = tmp_path / "output"
    commands = []
    monkeypatch.setattr(pipeline, "_environment", lambda root: {})
    monkeypatch.setattr(
        pipeline,
        "preprocess_input",
        lambda path, dest, **kwargs: (dest / "input_manifest.json").write_text('{"settings":{"seed":42}}'),
    )

    def fail(command, log, *, cwd):
        commands.append(command)
        failure(output)
        raise RuntimeError("geometry failed")

    monkeypatch.setattr(pipeline, "run_command", fail)
    return source, output, commands


def test_dense_failure_keeps_sparse_model_without_matcher_retry(tmp_path, monkeypatch):
    def produce_sparse(output):
        sparse = output / "sparse" / "0"
        sparse.mkdir(parents=True, exist_ok=True)
        (sparse / "points3D.bin").write_bytes(b"\0" * 9)

    source, output, commands = _failing_geometry_run(tmp_path, monkeypatch, produce_sparse)
    config = pipeline.profile_config("quality")
    with pytest.raises(RuntimeError, match="geometry failed"):
        pipeline.run_pipeline("quality", source, "dense", config_override=config, output_dir=output)
    assert len(commands) == 1
    degradation = json.loads((output / "degradation.json").read_text(encoding="utf-8"))
    assert degradation["reason"] == "geometry_dense_failed"
    assert (output / "sparse" / "0" / "points3D.bin").is_file()


@pytest.mark.parametrize(
    ("source_kind", "matchers"), [("video", ["sequential", "exhaustive"]), ("images", ["exhaustive", "sequential"])]
)
def test_matching_failure_retries_the_other_matcher(tmp_path, monkeypatch, source_kind, matchers):
    source, output, commands = _failing_geometry_run(tmp_path, monkeypatch, lambda output: None)
    monkeypatch.setattr(pipeline, "classify_input", lambda path: source_kind)
    config = pipeline.profile_config("quality")
    with pytest.raises(RuntimeError, match="geometry failed"):
        pipeline.run_pipeline("quality", source, "matching", config_override=config, output_dir=output)
    assert len(commands) == 2
    assert [command[command.index("--matcher") + 1] for command in commands] == matchers
    degradation = json.loads((output / "degradation.json").read_text(encoding="utf-8"))
    assert degradation["reason"] == "matcher_retry"


def test_environment_hashes_are_cached_and_force_rehash(tmp_path, monkeypatch):
    root = tmp_path
    (root / "src" / "rescene").mkdir(parents=True)
    (root / "src" / "rescene" / "module.py").write_text("value = 1\n", encoding="utf-8")
    for name in ("vggt", "gsplat", "spz", "dinov2"):
        (root / "third_party" / name).mkdir(parents=True)
        (root / "third_party" / name / ".revision").write_text(name, encoding="utf-8")
        (root / "third_party" / name / "source.py").write_text(name, encoding="utf-8")
    model = root / ".cache" / "models" / "VGGT-1B"
    model.mkdir(parents=True)
    (model / "model.safetensors").write_bytes(b"weights")
    (root / ".cache" / "models" / "VGGSfM").mkdir(parents=True)
    (root / ".cache" / "models" / "VGGSfM" / "vggsfm_v2_tracker.pt").write_bytes(b"tracker")
    (root / ".cache" / "torch" / "hub" / "checkpoints").mkdir(parents=True)
    (root / ".cache" / "torch" / "hub" / "checkpoints" / "dinov2_vitb14_reg4_pretrain.pth").write_bytes(b"dinov2")

    original = pipeline.sha256_file
    hashed: list = []

    def counting(path):
        hashed.append(path)
        return original(path)

    monkeypatch.setattr(pipeline, "sha256_file", counting)
    first = pipeline._environment(root)
    assert len(hashed) == 8
    cache_path = root / pipeline.ENVIRONMENT_HASH_CACHE
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cache["schema_version"] == 1 and len(cache["hashes"]) == 8
    entry = cache["hashes"][str((root / "src" / "rescene" / "module.py").resolve())]
    stat = (root / "src" / "rescene" / "module.py").stat()
    assert entry == {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": entry["sha256"]}

    hashed.clear()
    second = pipeline._environment(root)
    assert hashed == []
    assert second == first

    (root / "src" / "rescene" / "module.py").write_text("value = 2 changed\n", encoding="utf-8")
    hashed.clear()
    changed = pipeline._environment(root)
    assert len(hashed) == 1
    assert changed["source_tree_sha256"] != first["source_tree_sha256"]

    hashed.clear()
    rehashed = pipeline._environment(root, rehash=True)
    assert len(hashed) == 8
    assert rehashed == changed

    cache_path.unlink()
    hashed.clear()
    rebuilt = pipeline._environment(root)
    assert len(hashed) == 8
    assert rebuilt == changed


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
