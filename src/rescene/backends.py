"""Commands and adapters for the pinned upstream reconstruction tools."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from rescene.config import ProfileConfig


class BackendError(RuntimeError):
    """An upstream reconstruction command failed.

    ``log_offset`` marks where this attempt started appending, so failure
    classifiers read only the text this run produced.
    """

    def __init__(self, message: str, *, log_offset: int | None = None) -> None:
        super().__init__(message)
        self.log_offset = log_offset


def run_command(command: list[str], log_path: Path, *, cwd: Path | None = None) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    offset = log_path.stat().st_size if log_path.exists() else 0
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    with log_path.open("a", encoding="utf-8") as log:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if result.returncode:
        raise BackendError(f"command failed ({result.returncode}); see {log_path}", log_offset=offset)


def vggt_command(
    root: Path,
    scene_dir: Path,
    config: ProfileConfig,
    *,
    seed: int = 42,
    diagnostics: bool = False,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "rescene.vggt_runner",
        "--vendor-dir",
        str(root / "third_party" / "vggt"),
        "--pycolmap-dir",
        str(root / ".compat" / "pycolmap310"),
        "--scene-dir",
        str(scene_dir),
        "--checkpoint",
        str(root / ".cache" / "models" / "VGGT-1B" / "model.safetensors"),
        "--tracker-checkpoint",
        str(root / ".cache" / "models" / "VGGSfM" / "vggsfm_v2_tracker.pt"),
        "--dinov2-dir",
        str(root / "third_party" / "dinov2"),
        "--dinov2-checkpoint",
        str(root / ".cache" / "torch" / "hub" / "checkpoints" / "dinov2_vitb14_reg4_pretrain.pth"),
        "--query-frames",
        str(config.vggt_query_frames),
        "--max-query-points",
        str(config.vggt_max_query_points),
        "--max-reprojection-error",
        str(config.vggt_max_reprojection_error),
        "--seed",
        str(seed),
    ]
    if config.use_bundle_adjustment:
        command.append("--use-ba")
        if config.vggt_fine_tracking:
            command.append("--fine-tracking")
    if config.vggt_depth_confidence is not None:
        command.extend(("--depth-confidence", str(config.vggt_depth_confidence)))
    if config.vggt_track_observation_limit is not None:
        command.extend(("--track-observation-limit", str(config.vggt_track_observation_limit)))
    if config.vggt_grid_sampling and not config.use_bundle_adjustment:
        command.append("--grid-sampling")
    if config.vggt_query_coverage:
        command.append("--query-coverage")
    if diagnostics:
        command.append("--diagnostics")
    return command


def colmap_command(
    scene_dir: Path,
    *,
    sequential: bool,
    dense: bool,
    camera_model: str = "SIMPLE_RADIAL",
    mvs_max_image_size: int = 0,
    poisson_depth: int = 10,
    mapper: str = "incremental",
    matching_db: Path | None = None,
    seed: int | None = None,
    shared_camera: bool = False,
    mvs_iterations: int | None = None,
    sparse_threads: int | None = None,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "rescene.colmap_runner",
        "--scene-dir",
        str(scene_dir),
        "--matcher",
        "sequential" if sequential else "exhaustive",
        "--camera-model",
        camera_model,
        "--mvs-max-image-size",
        str(mvs_max_image_size),
        "--poisson-depth",
        str(poisson_depth),
    ]
    if dense:
        command.append("--dense")
    if mapper != "incremental":
        command.extend(("--mapper", mapper))
    if matching_db is not None:
        command.extend(("--matching-db", str(matching_db)))
    if seed is not None:
        command.extend(("--seed", str(seed)))
    if shared_camera:
        command.append("--shared-camera")
    if mvs_iterations is not None:
        command.extend(("--mvs-iterations", str(mvs_iterations)))
    if sparse_threads is not None:
        command.extend(("--sparse-threads", str(sparse_threads)))
    return command


def gsplat_command(
    root: Path, scene_dir: Path, output_dir: Path, config: ProfileConfig, *, seed: int = 42
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "rescene.gsplat_runner",
        "--split-file",
        str(scene_dir / "photometric_selection.json"),
        "default",
        "--data_dir",
        str(scene_dir),
        "--result_dir",
        str(output_dir),
        "--max_steps",
        str(config.gsplat_steps),
        "--eval_steps",
        str(config.gsplat_steps),
        "--save_steps",
        str(config.gsplat_steps),
        "--ply_steps",
        str(config.gsplat_steps),
        "--data_factor",
        str(config.gsplat_data_factor),
        "--disable_viewer",
        "--disable_video",
        "--save_ply",
        "--init-points",
        config.gsplat_init_points,
        "--seed",
        str(seed),
    ]
    if config.gsplat_packed:
        command.append("--packed")
    if config.gsplat_app_opt:
        command.append("--app_opt")
    if config.gsplat_depth_loss:
        command.append("--depth_loss")
    if config.gsplat_cache_images:
        command.append("--cache_images")
    if config.gsplat_train_workers is not None:
        command.extend(("--train-workers", str(config.gsplat_train_workers)))
    return command


LOG_TAIL_LIMIT = 50_000


def _attempt_log_tail(error: Exception, log_path: Path, limit: int = LOG_TAIL_LIMIT) -> str:
    """Read the bounded tail this attempt appended, never an earlier run's text."""
    offset = getattr(error, "log_offset", None)
    if not isinstance(offset, int) or offset < 0:
        return ""
    try:
        size = log_path.stat().st_size
        start = max(offset, size - limit)
        if start >= size:
            return ""
        with log_path.open("rb") as stream:
            stream.seek(start)
            return stream.read(size - start).decode("utf-8", errors="replace")
    except OSError:
        return ""


def is_cuda_oom(error: Exception, log_path: Path) -> bool:
    text = str(error) + _attempt_log_tail(error, log_path)
    lowered = text.lower()
    return "out of memory" in lowered and ("cuda" in lowered or "cublas" in lowered)


def is_vggt_ba_failure(error: Exception, log_path: Path) -> bool:
    text = str(error) + _attempt_log_tail(error, log_path)
    return "No reconstruction can be built with BA" in text
