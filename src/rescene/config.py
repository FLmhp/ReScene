"""Profile configuration shared by the CLI and pipeline."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from enum import StrEnum
from typing import Any


class ProfileName(StrEnum):
    """Supported reconstruction profiles."""

    FAST = "fast"
    BALANCED = "balanced"
    QUALITY = "quality"


@dataclass(frozen=True)
class ProfileConfig:
    """Settings that materially distinguish a reconstruction profile."""

    name: ProfileName
    geometry_backend: str
    max_frames: int
    use_bundle_adjustment: bool
    dense_reconstruction: bool
    gsplat_steps: int
    gsplat_data_factor: int = 1
    preprocess_max_side: int = 1600
    gsplat_packed: bool = False
    gsplat_app_opt: bool = False
    gsplat_depth_loss: bool = False
    gsplat_init_points: str = "sparse"
    vggt_query_frames: int = 8
    vggt_max_query_points: int = 2_048
    vggt_max_reprojection_error: float = 8.0
    vggt_fine_tracking: bool = False
    colmap_camera_model: str = "SIMPLE_RADIAL"
    colmap_mapper: str = "incremental"
    colmap_mvs_max_image_size: int = 0
    colmap_poisson_depth: int = 10
    vggt_depth_confidence: float | None = None
    vggt_track_observation_limit: int | None = None
    gsplat_cache_images: bool = False
    vggt_grid_sampling: bool = False
    vggt_query_coverage: bool = False
    colmap_shared_camera: bool = False
    colmap_mvs_iterations: int | None = None
    colmap_sparse_threads: int | None = None
    gsplat_train_workers: int | None = None

    def degraded(self) -> ProfileConfig:
        """Return the single bounded CUDA OOM fallback configuration."""
        return replace(
            self,
            max_frames=max(8, self.max_frames // 2),
            gsplat_data_factor=max(2, self.gsplat_data_factor * 2),
            gsplat_packed=True,
        )

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        config = asdict(self)
        for name in (
            "vggt_depth_confidence",
            "vggt_track_observation_limit",
            "colmap_mvs_iterations",
            "colmap_sparse_threads",
            "gsplat_train_workers",
        ):
            if config[name] is None:
                del config[name]
        for name in ("gsplat_cache_images", "vggt_grid_sampling", "vggt_query_coverage", "colmap_shared_camera"):
            if not config[name]:
                del config[name]
        return config

    def with_overrides(self, overrides: dict[str, Any]) -> ProfileConfig:
        """Return a validated calibration candidate without changing route identity."""
        allowed = {
            "max_frames",
            "gsplat_steps",
            "gsplat_data_factor",
            "preprocess_max_side",
            "gsplat_packed",
            "gsplat_app_opt",
            "gsplat_depth_loss",
            "gsplat_init_points",
            "gsplat_cache_images",
            "gsplat_train_workers",
            "vggt_query_frames",
            "vggt_max_query_points",
            "vggt_max_reprojection_error",
            "vggt_fine_tracking",
            "colmap_camera_model",
            "colmap_mapper",
            "colmap_mvs_max_image_size",
            "colmap_poisson_depth",
            "vggt_depth_confidence",
            "vggt_track_observation_limit",
            "vggt_grid_sampling",
            "vggt_query_coverage",
            "colmap_shared_camera",
            "colmap_mvs_iterations",
            "colmap_sparse_threads",
        }
        unknown = set(overrides) - allowed
        if unknown:
            raise ValueError(f"Unsupported profile overrides: {', '.join(sorted(unknown))}")
        vggt_overrides = set(overrides) & {
            "vggt_query_frames",
            "vggt_max_query_points",
            "vggt_max_reprojection_error",
            "vggt_fine_tracking",
            "vggt_query_coverage",
        }
        if vggt_overrides and (self.geometry_backend != "vggt" or not self.use_bundle_adjustment):
            raise ValueError(
                "VGGT bundle adjustment overrides are not applicable to "
                f"{self.name}: {', '.join(sorted(vggt_overrides))}"
            )
        colmap_overrides = set(overrides) & {
            "colmap_camera_model",
            "colmap_mapper",
            "colmap_mvs_max_image_size",
            "colmap_poisson_depth",
            "colmap_shared_camera",
            "colmap_mvs_iterations",
            "colmap_sparse_threads",
        }
        if colmap_overrides and self.geometry_backend != "colmap":
            raise ValueError(
                f"COLMAP overrides are not applicable to {self.name}: {', '.join(sorted(colmap_overrides))}"
            )
        updated = replace(self, **overrides)
        if updated.vggt_grid_sampling and (
            self.geometry_backend != "vggt" or self.use_bundle_adjustment or updated.vggt_depth_confidence is not None
        ):
            raise ValueError("Grid sampling requires non-BA VGGT and the default depth threshold")
        if updated.colmap_shared_camera and (
            updated.colmap_camera_model != "PINHOLE" or updated.colmap_mapper != "incremental"
        ):
            raise ValueError("Shared camera requires incremental mapping with PINHOLE intrinsics")
        iterations = updated.colmap_mvs_iterations
        if iterations is not None and (type(iterations) is not int or not 1 <= iterations <= 5):
            raise ValueError("colmap_mvs_iterations must be an integer between 1 and 5")
        threads = updated.colmap_sparse_threads
        if threads is not None and (
            type(threads) is not int or not 1 <= threads <= 12 or updated.colmap_mapper != "incremental"
        ):
            raise ValueError("colmap_sparse_threads requires incremental mapping and an integer between 1 and 12")
        confidence = updated.vggt_depth_confidence
        if confidence is not None and (
            self.geometry_backend != "vggt"
            or self.use_bundle_adjustment
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not 1 <= confidence <= 5
        ):
            raise ValueError("vggt_depth_confidence must be between 1 and 5 on the non-BA VGGT route")
        track_limit = updated.vggt_track_observation_limit
        if track_limit is not None and (
            self.geometry_backend != "vggt" or type(track_limit) is not int or not 4096 <= track_limit <= 163840
        ):
            raise ValueError("vggt_track_observation_limit must be between 4096 and 163840 on a VGGT route")
        if updated.gsplat_app_opt is True:
            raise ValueError(
                "gsplat_app_opt requires a deployable appearance protocol; "
                "replace historical matrix candidates with candidates using a deployable protocol"
            )
        integers = {
            "max_frames": updated.max_frames,
            "gsplat_steps": updated.gsplat_steps,
            "gsplat_data_factor": updated.gsplat_data_factor,
            "preprocess_max_side": updated.preprocess_max_side,
            "vggt_query_frames": updated.vggt_query_frames,
            "vggt_max_query_points": updated.vggt_max_query_points,
        }
        invalid = [
            name
            for name, value in integers.items()
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0
        ]
        if (
            not isinstance(updated.vggt_max_reprojection_error, (int, float))
            or isinstance(updated.vggt_max_reprojection_error, bool)
            or updated.vggt_max_reprojection_error <= 0
        ):
            invalid.append("vggt_max_reprojection_error")
        if invalid:
            raise ValueError(f"Profile values must be positive: {', '.join(invalid)}")
        if updated.gsplat_init_points not in {"sparse", "dense"}:
            raise ValueError("gsplat_init_points must be sparse or dense")
        if updated.gsplat_init_points == "dense" and not updated.dense_reconstruction:
            raise ValueError("gsplat_init_points=dense requires a dense-capable route")
        for name in (
            "gsplat_packed",
            "gsplat_app_opt",
            "gsplat_depth_loss",
            "gsplat_cache_images",
            "vggt_fine_tracking",
            "vggt_grid_sampling",
            "vggt_query_coverage",
            "colmap_shared_camera",
        ):
            if not isinstance(getattr(updated, name), bool):
                raise ValueError(f"{name} must be true or false")
        if updated.gsplat_cache_images and updated.max_frames * updated.preprocess_max_side**2 * 3 > 2 * 1024**3:
            raise ValueError("gsplat_cache_images exceeds the 2 GiB decoded RGB budget")
        workers = updated.gsplat_train_workers
        if workers is not None and (type(workers) is not int or not 1 <= workers <= 12):
            raise ValueError("gsplat_train_workers must be an integer between 1 and 12")
        if updated.vggt_query_frames > updated.max_frames:
            raise ValueError("vggt_query_frames cannot exceed max_frames")
        if updated.colmap_camera_model not in {"SIMPLE_RADIAL", "OPENCV", "PINHOLE", "SIMPLE_PINHOLE"}:
            raise ValueError("colmap_camera_model must be SIMPLE_RADIAL, OPENCV, PINHOLE, or SIMPLE_PINHOLE")
        if updated.colmap_mapper not in ("incremental", "global"):
            raise ValueError("colmap_mapper must be incremental or global")
        if (
            not isinstance(updated.colmap_mvs_max_image_size, int)
            or isinstance(updated.colmap_mvs_max_image_size, bool)
            or updated.colmap_mvs_max_image_size < 0
        ):
            raise ValueError("colmap_mvs_max_image_size must be >= 0")
        if (
            not isinstance(updated.colmap_poisson_depth, int)
            or isinstance(updated.colmap_poisson_depth, bool)
            or not 1 <= updated.colmap_poisson_depth <= 14
        ):
            raise ValueError("colmap_poisson_depth must be between 1 and 14")
        return updated


PROFILES: dict[ProfileName, ProfileConfig] = {
    ProfileName.FAST: ProfileConfig(
        name=ProfileName.FAST,
        geometry_backend="vggt",
        max_frames=80,
        use_bundle_adjustment=False,
        dense_reconstruction=False,
        gsplat_steps=7_000,
    ),
    ProfileName.BALANCED: ProfileConfig(
        name=ProfileName.BALANCED,
        geometry_backend="vggt",
        max_frames=80,
        use_bundle_adjustment=True,
        dense_reconstruction=False,
        gsplat_steps=20_000,
        vggt_max_query_points=1_024,
    ),
    ProfileName.QUALITY: ProfileConfig(
        name=ProfileName.QUALITY,
        geometry_backend="colmap",
        max_frames=250,
        use_bundle_adjustment=True,
        dense_reconstruction=True,
        gsplat_steps=20_000,
    ),
}


def profile_config(name: str) -> ProfileConfig:
    """Resolve a profile name or raise a user-facing validation error."""
    try:
        return PROFILES[ProfileName(name.lower())]
    except ValueError as error:
        choices = ", ".join(item.value for item in ProfileName)
        raise ValueError(f"Unknown profile {name!r}; choose one of: {choices}") from error
