import pytest

from rescene.config import profile_config


def test_profiles_and_single_oom_degradation() -> None:
    fast = profile_config("FAST")
    balanced = profile_config("balanced")
    quality = profile_config("quality")

    assert fast.gsplat_steps == 7_000
    assert balanced.use_bundle_adjustment
    assert balanced.gsplat_steps == 20_000
    assert balanced.vggt_max_query_points == 1_024
    assert quality.dense_reconstruction and quality.max_frames == 250
    assert quality.gsplat_steps == 20_000
    degraded = balanced.degraded()
    assert degraded.max_frames == 40
    assert degraded.gsplat_data_factor == 2
    assert degraded.gsplat_packed

    candidate = balanced.with_overrides({"gsplat_steps": 20_000, "vggt_max_query_points": 1_024})
    assert candidate.gsplat_steps == 20_000
    assert candidate.vggt_max_query_points == 1_024
    with pytest.raises(ValueError, match="Unsupported"):
        balanced.with_overrides({"geometry_backend": "colmap"})


@pytest.mark.parametrize("profile", ["fast", "quality"])
@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("vggt_query_frames", 4),
        ("vggt_max_query_points", 512),
        ("vggt_max_reprojection_error", 4.0),
        ("vggt_fine_tracking", True),
    ],
)
def test_vggt_bundle_adjustment_overrides_require_capability(profile: str, name: str, value: int | float) -> None:
    with pytest.raises(ValueError, match=name):
        profile_config(profile).with_overrides({name: value})
    assert getattr(profile_config("balanced").with_overrides({name: value}), name) == value


def test_appearance_optimization_requires_deployable_protocol() -> None:
    for profile in ("fast", "balanced", "quality"):
        config = profile_config(profile)
        assert not config.gsplat_app_opt
        assert not config.with_overrides({"gsplat_app_opt": False}).gsplat_app_opt
        with pytest.raises(ValueError, match="deployable appearance protocol"):
            config.with_overrides({"gsplat_app_opt": True})


def test_preprocessing_resolution_is_bounded() -> None:
    quality = profile_config("quality")
    assert quality.preprocess_max_side == 1600
    assert quality.with_overrides({"preprocess_max_side": 2400}).preprocess_max_side == 2400
    for invalid in (0, -1600, True, 1.5):
        with pytest.raises(ValueError, match="preprocess_max_side"):
            quality.with_overrides({"preprocess_max_side": invalid})


def test_dense_initialization_requires_dense_route() -> None:
    quality = profile_config("quality")
    assert quality.gsplat_init_points == "sparse"
    assert quality.with_overrides({"gsplat_init_points": "dense"}).gsplat_init_points == "dense"
    with pytest.raises(ValueError, match="dense-capable"):
        profile_config("fast").with_overrides({"gsplat_init_points": "dense"})
    with pytest.raises(ValueError, match="sparse or dense"):
        quality.with_overrides({"gsplat_init_points": "random"})


@pytest.mark.parametrize("model", ["SIMPLE_RADIAL", "OPENCV", "PINHOLE", "SIMPLE_PINHOLE"])
def test_colmap_camera_model_override(model: str) -> None:
    assert profile_config("quality").with_overrides({"colmap_camera_model": model}).colmap_camera_model == model


@pytest.mark.parametrize("profile", ["fast", "balanced"])
@pytest.mark.parametrize("name", ["colmap_camera_model", "colmap_mvs_max_image_size", "colmap_poisson_depth"])
def test_colmap_overrides_require_colmap_backend(profile: str, name: str) -> None:
    value = {"colmap_camera_model": "PINHOLE", "colmap_mvs_max_image_size": 1600, "colmap_poisson_depth": 10}[name]
    with pytest.raises(ValueError, match=name):
        profile_config(profile).with_overrides({name: value})


def test_dense_overrides_are_bounded() -> None:
    quality = profile_config("quality")
    assert quality.colmap_mvs_max_image_size == 0
    assert quality.colmap_poisson_depth == 10

    tuned = quality.with_overrides({"colmap_mvs_max_image_size": 1200, "colmap_poisson_depth": 12})
    assert tuned.colmap_mvs_max_image_size == 1200
    assert tuned.colmap_poisson_depth == 12
    assert quality.with_overrides({"colmap_mvs_max_image_size": 0}).colmap_mvs_max_image_size == 0

    with pytest.raises(ValueError, match="colmap_mvs_max_image_size"):
        quality.with_overrides({"colmap_mvs_max_image_size": -1})
    for invalid in (0, 15, True):
        with pytest.raises(ValueError, match="colmap_poisson_depth"):
            quality.with_overrides({"colmap_poisson_depth": invalid})
