import json
from pathlib import Path

import pytest

from rescene.benchmark import load_candidates, load_dataset_manifest, run_dataset_benchmark


def _write_configs(tmp_path: Path) -> tuple[Path, Path]:
    manifest = tmp_path / "dataset.json"
    manifest.write_text(
        json.dumps(
            {
                "license_target": "academic-noncommercial",
                "scenes": [
                    {"id": "train", "dataset": "unit", "split": "calibration", "input": "/missing/train"},
                    {"id": "test", "dataset": "unit", "split": "test", "input": "/missing/test"},
                ],
            }
        ),
        encoding="utf-8",
    )
    candidates = tmp_path / "candidates.json"
    candidates.write_text(
        json.dumps(
            {
                "profiles": {
                    "fast": [
                        {"id": "baseline", "estimated_minutes": 4, "overrides": {}},
                        {"id": "short", "estimated_minutes": 2, "overrides": {"max_frames": 32}},
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    return manifest, candidates


def test_benchmark_dry_run_builds_calibration_only_plan(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    output = run_dataset_benchmark(manifest, candidates, ["fast"], "unit", 24, dry_run=True)
    plan = json.loads((output / "benchmark-plan.json").read_text(encoding="utf-8"))

    assert len(plan["trials"]) == 2
    assert {trial["scene_id"] for trial in plan["trials"]} == {"train"}
    assert not (tmp_path / "runs").exists()


def test_historical_appearance_matrices_require_deployable_protocol() -> None:
    root = Path(__file__).parents[1]
    manifest = root / "configs" / "datasets" / "academic-v1.json"

    assert load_dataset_manifest(manifest)["license_target"] == "academic-noncommercial"
    for name in ("candidates-v1.json", "route-screen-v2.json"):
        candidates = root / "configs" / "calibration" / name
        with pytest.raises(ValueError, match="deployable appearance protocol"):
            load_candidates(candidates)


def test_candidate_overrides_reject_route_changes(tmp_path: Path) -> None:
    _, candidates = _write_configs(tmp_path)
    value = json.loads(candidates.read_text(encoding="utf-8"))
    value["profiles"]["fast"][0]["overrides"] = {"geometry_backend": "colmap"}
    candidates.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="Unsupported"):
        load_candidates(candidates)


def test_benchmark_preflight_rejects_missing_inputs(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    with pytest.raises(FileNotFoundError, match="Missing calibration inputs"):
        run_dataset_benchmark(manifest, candidates, ["fast"], "missing", 24)


def test_resume_counts_planned_minutes_against_budget(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    run_dir = tmp_path / "runs" / "budget-fast-baseline-train"
    run_dir.mkdir(parents=True)
    (run_dir / "metrics.json").write_text(json.dumps({"schema_version": 2, "total_seconds": 3_600}), encoding="utf-8")
    monkeypatch.setattr("rescene.benchmark.run_pipeline", lambda *args, **kwargs: pytest.fail("budget exceeded"))

    output = run_dataset_benchmark(manifest, candidates, ["fast"], "budget", 5 / 60, resume=True)

    failures = json.loads((output / "failures.json").read_text(encoding="utf-8"))
    assert failures == [{"run_id": "budget-fast-short-train", "reason": "budget"}]


def test_repeat_expands_run_ids_and_aggregates_medians(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    monkeypatch.setenv("RESCENE_RUN_ROOT", str(tmp_path))

    def fake_run_pipeline(profile, input_path, run_id, **kwargs):
        config = kwargs["config_override"]
        runs = tmp_path / "runs" / run_id
        runs.mkdir(parents=True)
        repeat = 2 if run_id.endswith("-r2") else 1
        (runs / "metrics.json").write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "total_seconds": 60.0 * repeat,
                    "psnr": 20.0 + repeat,
                    "ssim": 0.5,
                    "lpips": 0.3,
                    "validation_selected": ["a.jpg", "b.jpg"] if config.max_frames == 80 else ["a.jpg"],
                    "validation_registered_frames": ["a.jpg"],
                    "validation_registration_rate": 0.5,
                }
            ),
            encoding="utf-8",
        )
        return runs

    monkeypatch.setattr("rescene.benchmark.run_pipeline", fake_run_pipeline)

    output = run_dataset_benchmark(
        manifest,
        candidates,
        ["fast"],
        "repeat",
        24,
        split="calibration",
        repeat=2,
        record_hashes=False,
        min_free_disk_bytes=1,
    )
    leaderboard = json.loads((output / "leaderboard.json").read_text(encoding="utf-8"))
    by_candidate = {(row["candidate_id"], row["scene_id"]): row for row in leaderboard}

    baseline = by_candidate[("baseline", "train")]
    assert baseline["runs"] == ["repeat-fast-baseline-train", "repeat-fast-baseline-train-r2"]
    assert baseline["repeat_count"] == 2 and baseline["completed_runs"] == 2
    assert baseline["median_seconds"] == 90.0
    assert baseline["median_psnr"] == 21.5

    candidate = by_candidate[("short", "train")]
    assert candidate["common_validation_frames_total"] == 1
    assert candidate["common_validation_registered"] == 1
    assert candidate["common_validation_registration_rate"] == 1.0


@pytest.mark.parametrize("budget", [None, 0, -1])
def test_disk_preflight_requires_positive_budget(monkeypatch, tmp_path: Path, budget) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    monkeypatch.setattr("rescene.benchmark.run_pipeline", lambda *args, **kwargs: pytest.fail("trial started"))

    output = run_dataset_benchmark(manifest, candidates, ["fast"], "disk", 24, min_free_disk_bytes=budget)

    failure = json.loads((output / "failures.json").read_text(encoding="utf-8"))[0]
    assert failure["reason"] == "disk_preflight"
    assert failure["status"] == "invalid_budget"
    assert failure["required_bytes"] == budget
    assert failure["free_bytes"] is None


def test_disk_preflight_records_disk_usage_errors(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    def failed_usage(path):
        raise OSError("unavailable")

    monkeypatch.setattr("rescene.benchmark.shutil.disk_usage", failed_usage)
    monkeypatch.setattr("rescene.benchmark.run_pipeline", lambda *args, **kwargs: pytest.fail("trial started"))
    output = run_dataset_benchmark(manifest, candidates, ["fast"], "disk-error", 24, min_free_disk_bytes=1)
    failure = json.loads((output / "failures.json").read_text(encoding="utf-8"))[0]
    assert failure["status"] == "check_failed"
    assert "unavailable" in failure["error"]


@pytest.mark.parametrize(
    "metrics_payload",
    ['{"schema_version": 2, "total_sec', json.dumps({"schema_version": 2, "psnr": 20.0})],
)
def test_incomplete_trial_metrics_are_rerun_and_leaderboard_stays_valid(
    monkeypatch, tmp_path: Path, metrics_payload: str
) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    run_dir = tmp_path / "runs" / "incomplete-fast-baseline-train"
    run_dir.mkdir(parents=True)
    (run_dir / "metrics.json").write_text(metrics_payload, encoding="utf-8")
    resumed: list[bool] = []

    def fake_run_pipeline(profile, input_path, run_id, **kwargs):
        resumed.append(kwargs["resume"])
        output_dir = kwargs["output_dir"]
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "metrics.json").write_text(
            json.dumps({"schema_version": 2, "total_seconds": 60.0, "psnr": 20.0}), encoding="utf-8"
        )

    monkeypatch.setattr("rescene.benchmark.run_pipeline", fake_run_pipeline)

    output = run_dataset_benchmark(manifest, candidates, ["fast"], "incomplete", 24, min_free_disk_bytes=1)

    assert resumed == [True, False]
    leaderboard = json.loads((output / "leaderboard.json").read_text(encoding="utf-8"))
    baseline = next(row for row in leaderboard if row["candidate_id"] == "baseline")
    assert baseline["completed_runs"] == 1
    assert baseline["median_seconds"] == 60.0
    assert not list(output.glob(".*.tmp-*"))


def test_disk_preflight_checks_each_trial_on_selected_root(monkeypatch, tmp_path: Path) -> None:
    manifest, candidates = _write_configs(tmp_path)
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["scenes"][0]["input"] = str(tmp_path)
    manifest.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    runs_root = tmp_path / "data-disk" / "runs-v3"
    free = iter([100, 49])
    checked = []
    started = []

    def disk_usage(path):
        checked.append(path)
        return type("Usage", (), {"free": next(free)})()

    def run_pipeline(profile, input_path, run_id, **kwargs):
        started.append(kwargs["output_dir"])
        kwargs["output_dir"].mkdir(parents=True)
        (kwargs["output_dir"] / "metrics.json").write_text(
            json.dumps({"schema_version": 2, "total_seconds": 1.0}), encoding="utf-8"
        )

    monkeypatch.setattr("rescene.benchmark.shutil.disk_usage", disk_usage)
    monkeypatch.setattr("rescene.benchmark.run_pipeline", run_pipeline)
    output = run_dataset_benchmark(
        manifest, candidates, ["fast"], "disk", 24, runs_root=runs_root, min_free_disk_bytes=50
    )

    assert checked == [runs_root, runs_root]
    assert started == [runs_root / "disk-fast-baseline-train"]
    preflights = json.loads((output / "disk-preflights.json").read_text(encoding="utf-8"))
    assert [(item["status"], item["free_bytes"]) for item in preflights] == [("ok", 100), ("insufficient_space", 49)]
    assert json.loads((output / "failures.json").read_text(encoding="utf-8"))[0]["reason"] == "disk_preflight"
    plan = json.loads((output / "benchmark-plan.json").read_text(encoding="utf-8"))
    assert plan["runs_root"] == str(runs_root)
    assert len(plan["input_files_sha256"]["manifest"]) == 64
    assert len(plan["input_files_sha256"]["candidates"]) == 64
    rows = json.loads((output / "leaderboard.json").read_text(encoding="utf-8"))
    assert next(row for row in rows if row["candidate_id"] == "baseline")["completed_runs"] == 1
