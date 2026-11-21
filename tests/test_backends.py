import sys
from pathlib import Path

import pytest

from rescene.backends import BackendError, gsplat_command, is_cuda_oom, is_vggt_ba_failure, run_command, vggt_command
from rescene.config import profile_config


def test_upstream_commands_are_isolated(tmp_path: Path) -> None:
    vggt = vggt_command(tmp_path, tmp_path / "run", profile_config("balanced"))
    gsplat = gsplat_command(tmp_path, tmp_path / "run", tmp_path / "output", profile_config("fast"))

    assert "--use-ba" in vggt
    assert str(tmp_path / "third_party" / "vggt") in vggt
    assert str(tmp_path / ".compat" / "pycolmap310") in vggt
    assert str(tmp_path / ".cache" / "models" / "VGGSfM" / "vggsfm_v2_tracker.pt") in vggt
    assert str(tmp_path / "third_party" / "dinov2") in vggt
    assert str(tmp_path / ".cache" / "torch" / "hub" / "checkpoints" / "dinov2_vitb14_reg4_pretrain.pth") in vggt
    assert "--max-query-points" in vggt and "1024" in vggt
    assert "rescene.gsplat_runner" in gsplat
    assert "--split-file" in gsplat and "--test_every" not in gsplat
    assert "--disable_viewer" in gsplat and "--disable_video" in gsplat
    assert "--save_ply" in gsplat and "7000" in gsplat
    assert "True" not in gsplat


def test_cuda_oom_detection_reads_current_attempt_log(tmp_path: Path) -> None:
    log = tmp_path / "error.log"
    log.write_text("torch.OutOfMemoryError: CUDA out of memory", encoding="utf-8")
    assert is_cuda_oom(BackendError("failed", log_offset=0), log)
    assert not is_cuda_oom(BackendError("syntax error", log_offset=0), tmp_path / "missing")


def test_vggt_ba_failure_detection_reads_current_attempt_log(tmp_path: Path) -> None:
    log = tmp_path / "geometry.log"
    log.write_text("ValueError: No reconstruction can be built with BA", encoding="utf-8")
    assert is_vggt_ba_failure(BackendError("failed", log_offset=0), log)
    assert not is_vggt_ba_failure(BackendError("failed", log_offset=0), tmp_path / "missing")


def test_earlier_attempt_text_does_not_trigger_fallbacks(tmp_path: Path) -> None:
    log = tmp_path / "geometry.log"
    log.write_text(
        "CUDA out of memory\nValueError: No reconstruction can be built with BA\n",
        encoding="utf-8",
    )
    offset = log.stat().st_size
    log.write_text(log.read_text(encoding="utf-8") + "RuntimeError: generic stage failure\n", encoding="utf-8")
    error = BackendError("command failed (1)", log_offset=offset)

    assert not is_cuda_oom(error, log)
    assert not is_vggt_ba_failure(error, log)

    log.write_text(log.read_text(encoding="utf-8") + "CUDA out of memory\n", encoding="utf-8")
    assert is_cuda_oom(error, log)


def test_unattributed_errors_do_not_read_shared_log(tmp_path: Path) -> None:
    log = tmp_path / "geometry.log"
    log.write_text("CUDA out of memory\nNo reconstruction can be built with BA\n", encoding="utf-8")
    assert not is_cuda_oom(RuntimeError("generic"), log)
    assert not is_vggt_ba_failure(RuntimeError("generic"), log)


def test_run_command_reports_the_attempt_offset(tmp_path: Path) -> None:
    log = tmp_path / "training.log"
    log.write_text("earlier attempt\n", encoding="utf-8")

    run_command([sys.executable, "-c", "print('ok')"], log)
    attempt_start = log.stat().st_size
    with pytest.raises(BackendError) as raised:
        run_command([sys.executable, "-c", "raise SystemExit(3)"], log)
    assert raised.value.log_offset == attempt_start

    log.write_text(log.read_text(encoding="utf-8") + "CUDA out of memory\n", encoding="utf-8")
    assert is_cuda_oom(raised.value, log)


def test_long_attempt_log_is_read_from_a_bounded_tail(tmp_path: Path) -> None:
    log = tmp_path / "training.log"
    log.write_text("x" * 80_000 + "CUDA out of memory\n", encoding="utf-8")
    assert is_cuda_oom(BackendError("failed", log_offset=0), log)

    log.write_text("CUDA out of memory\n" + "x" * 80_000, encoding="utf-8")
    assert not is_cuda_oom(BackendError("failed", log_offset=0), log)

    log.write_text("CUDA out of memory\n", encoding="utf-8")
    assert not is_cuda_oom(BackendError("failed", log_offset=10_000), log)


def test_vggt_screening_options_are_opt_in(tmp_path: Path) -> None:
    baseline = profile_config("fast")
    assert "vggt_track_observation_limit" not in baseline.to_dict()
    assert "--depth-confidence" not in vggt_command(tmp_path, tmp_path, baseline)
    config = baseline.with_overrides({"vggt_depth_confidence": 3.0, "vggt_track_observation_limit": 65536})
    command = vggt_command(tmp_path, tmp_path, config)
    assert command[command.index("--depth-confidence") + 1] == "3.0"
    assert command[command.index("--track-observation-limit") + 1] == "65536"


def test_gsplat_image_cache_is_opt_in(tmp_path: Path) -> None:
    baseline = profile_config("fast")
    assert "gsplat_cache_images" not in baseline.to_dict()
    assert "--cache_images" not in gsplat_command(tmp_path, tmp_path, tmp_path, baseline)
    config = baseline.with_overrides({"gsplat_cache_images": True})
    assert "--cache_images" in gsplat_command(tmp_path, tmp_path, tmp_path, config)
    assert "--train-workers" not in gsplat_command(tmp_path, tmp_path, tmp_path, baseline)
    config = baseline.with_overrides({"gsplat_train_workers": 8})
    command = gsplat_command(tmp_path, tmp_path, tmp_path, config)
    assert command[command.index("--train-workers") + 1] == "8"
