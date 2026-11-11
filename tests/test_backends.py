from pathlib import Path

from rescene.backends import gsplat_command, is_cuda_oom, is_vggt_ba_failure, vggt_command
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


def test_cuda_oom_detection_reads_log(tmp_path: Path) -> None:
    log = tmp_path / "error.log"
    log.write_text("torch.OutOfMemoryError: CUDA out of memory", encoding="utf-8")
    assert is_cuda_oom(RuntimeError("failed"), log)
    assert not is_cuda_oom(RuntimeError("syntax error"), tmp_path / "missing")


def test_vggt_ba_failure_detection_reads_log(tmp_path: Path) -> None:
    log = tmp_path / "geometry.log"
    log.write_text("ValueError: No reconstruction can be built with BA", encoding="utf-8")
    assert is_vggt_ba_failure(RuntimeError("failed"), log)
    assert not is_vggt_ba_failure(RuntimeError("failed"), tmp_path / "missing")
