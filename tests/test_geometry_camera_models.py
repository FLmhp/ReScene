from types import SimpleNamespace

import pytest

from rescene.geometry_metrics import _focal


@pytest.mark.parametrize(
    "camera",
    [
        SimpleNamespace(model_name="SIMPLE_PINHOLE", params=[100.0, 1.0, 2.0]),
        SimpleNamespace(model=SimpleNamespace(name="SIMPLE_PINHOLE"), params=[100.0, 1.0, 2.0]),
    ],
)
def test_focal_supports_legacy_and_current_pycolmap_cameras(camera: SimpleNamespace) -> None:
    assert _focal(camera) == 100.0


@pytest.mark.parametrize(
    "camera",
    [
        SimpleNamespace(model_name="PINHOLE", params=[100.0, 140.0, 2.0, 3.0]),
        SimpleNamespace(model=SimpleNamespace(name="PINHOLE"), params=[100.0, 140.0, 2.0, 3.0]),
    ],
)
def test_averaged_focal_supports_legacy_and_current_pycolmap_cameras(camera: SimpleNamespace) -> None:
    assert _focal(camera) == 120.0


def test_unknown_camera_model_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unsupported camera model"):
        _focal(SimpleNamespace(model_name="FISHEYE", params=[100.0]))


def test_projection_uses_camera_pose_and_pinhole() -> None:
    import numpy as np

    from rescene.geometry_metrics import _project_point

    camera = SimpleNamespace(model_name="PINHOLE", params=[100.0, 200.0, 320.0, 240.0])
    image = SimpleNamespace(cam_from_world=lambda: np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]))
    projected = _project_point(image, camera, np.array([1.0, 2.0, 4.0]))
    assert projected is not None
    assert projected[0] == pytest.approx(345.0)
    assert projected[1] == pytest.approx(340.0)


def test_projection_skips_points_behind_the_camera() -> None:
    import numpy as np

    from rescene.geometry_metrics import _project_point

    camera = SimpleNamespace(model=SimpleNamespace(name="SIMPLE_PINHOLE"), params=[100.0, 320.0, 240.0])
    image = SimpleNamespace(cam_from_world=lambda: np.eye(4))
    assert _project_point(image, camera, np.array([0.0, 0.0, -1.0])) is None
