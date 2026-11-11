from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from rescene.cli import main


def test_run_command_applies_dense_overrides(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def fake_run_pipeline(profile, input_path, run_id, **kwargs):
        captured.update({"profile": profile, "run_id": run_id, **kwargs})
        return tmp_path

    monkeypatch.setattr("rescene.cli.run_pipeline", fake_run_pipeline)

    main(
        [
            "run",
            "--profile",
            "quality",
            "--input",
            str(tmp_path),
            "--run-id",
            "cli-run",
            "--colmap-mvs-max-image-size",
            "1200",
            "--colmap-poisson-depth",
            "12",
            "--diagnostics",
            "--record-input-hashes",
        ]
    )

    config = captured["config_override"]
    assert config.colmap_mvs_max_image_size == 1200
    assert config.colmap_poisson_depth == 12
    assert captured["diagnostics"] is True
    assert captured["record_hashes"] is True
    assert captured["validation_sources"] is None


def test_run_command_rejects_invalid_dense_overrides(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("rescene.cli.run_pipeline", lambda *args, **kwargs: pytest.fail("must validate first"))

    with pytest.raises(ValueError, match="colmap_poisson_depth"):
        main(
            [
                "run",
                "--profile",
                "quality",
                "--input",
                str(tmp_path),
                "--run-id",
                "cli-run",
                "--colmap-poisson-depth",
                "20",
            ]
        )


def _fast_candidates(tmp_path: Path) -> Path:
    candidates = tmp_path / "candidates.json"
    candidates.write_text('{"profiles": {"fast": [{"id": "baseline", "overrides": {}}]}}', encoding="utf-8")
    return candidates


def test_benchmark_dry_run_expands_repeats(monkeypatch, tmp_path: Path) -> None:
    root = Path(__file__).parents[1]
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    main(
        [
            "benchmark",
            "--manifest",
            str(root / "configs" / "datasets" / "academic-v1.json"),
            "--candidates",
            str(_fast_candidates(tmp_path)),
            "--profiles",
            "fast",
            "--run-prefix",
            "cli-repeat",
            "--repeat",
            "3",
            "--dry-run",
        ]
    )

    plan = (tmp_path / "calibration" / "cli-repeat" / "benchmark-plan.json").read_text(encoding="utf-8")
    import json

    parsed = json.loads(plan)
    assert parsed["repeat"] == 3
    assert any(trial["run_id"].endswith("-r3") for trial in parsed["trials"])


def test_cpu_preprocess_command(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "input"
    source.mkdir()
    for index in range(2):
        pixels = np.zeros((16, 16, 3), dtype="uint8")
        pixels[:, index * 8 : index * 8 + 8] = 255
        Image.fromarray(pixels).save(source / f"{index}.png")
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    main(["preprocess", "--input", str(source), "--scene", "cpu"])

    assert (tmp_path / "data" / "cpu" / "input_manifest.json").exists()


def test_dataset_benchmark_dry_run_command(monkeypatch, tmp_path: Path) -> None:
    root = Path(__file__).parents[1]
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))

    main(
        [
            "benchmark",
            "--manifest",
            str(root / "configs" / "datasets" / "academic-v1.json"),
            "--candidates",
            str(_fast_candidates(tmp_path)),
            "--profiles",
            "fast",
            "--run-prefix",
            "cli-dry-run",
            "--dry-run",
        ]
    )

    assert (tmp_path / "calibration" / "cli-dry-run" / "benchmark-plan.json").exists()


def test_benchmark_forwards_disk_options(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    def benchmark(*args, **kwargs):
        captured.update(kwargs)
        return tmp_path

    monkeypatch.setattr("rescene.cli.run_dataset_benchmark", benchmark)
    main(
        [
            "benchmark",
            "--manifest",
            "dataset.json",
            "--candidates",
            "candidates.json",
            "--runs-root",
            str(tmp_path / "runs-v3"),
            "--min-free-disk-bytes",
            "1234",
        ]
    )
    assert captured["runs_root"] == tmp_path / "runs-v3"
    assert captured["min_free_disk_bytes"] == 1234


def test_direct_benchmark_checks_disk_before_each_run(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("RESCENE_ROOT", str(tmp_path))
    free = iter([100, 1])
    monkeypatch.setattr("rescene.benchmark.shutil.disk_usage", lambda path: type("Usage", (), {"free": next(free)})())
    started = []
    monkeypatch.setattr("rescene.cli.run_pipeline", lambda *args, **kwargs: started.append(kwargs["output_dir"]))
    runs = tmp_path / "data" / "runs-v3"
    with pytest.raises(RuntimeError, match="insufficient_space"):
        main(
            [
                "benchmark",
                "--input",
                str(tmp_path),
                "--profiles",
                "fast",
                "balanced",
                "--run-prefix",
                "direct",
                "--runs-root",
                str(runs),
                "--min-free-disk-bytes",
                "50",
            ]
        )
    assert started == [runs / "direct-fast"]
    import json

    failures = json.loads((tmp_path / "calibration" / "direct" / "failures.json").read_text(encoding="utf-8"))
    assert failures[0]["run_id"] == "direct-balanced"
    assert failures[0]["free_bytes"] == 1


def test_reuse_commands_forward_arguments(monkeypatch, tmp_path: Path, capsys) -> None:
    captured = {}

    def pipeline(*args, **kwargs):
        captured.update(kwargs)
        return tmp_path

    monkeypatch.setattr("rescene.cli.run_pipeline", pipeline)
    main(
        [
            "run",
            "--profile",
            "fast",
            "--input",
            str(tmp_path),
            "--run-id",
            "reuse",
            "--reuse-bundle",
            str(tmp_path / "bundle"),
            "--reuse-sha256",
            "abc",
            "--reuse-stage",
            "dense",
        ]
    )
    assert captured["reuse_bundle"] == tmp_path / "bundle"
    assert captured["reuse_sha256"] == "abc"
    assert captured["reuse_stage"] == "dense"

    monkeypatch.setattr("rescene.cli.create_reuse_bundle", lambda source, target: f"{source}:{target}")
    main(["create-reuse-bundle", "--source-run", "source", "--bundle-dir", "bundle"])
    assert "source:bundle" in capsys.readouterr().out
