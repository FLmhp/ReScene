"""Reprojection diagnostics for bundle adjustment, in pixels.

The metric compares the same ``(image_id, point3D_id)`` observations in the
COLMAP model captured before bundle adjustment and the model written after it.
Both snapshots are copies of one reconstruction, so image and point ids are
stable even though the upstream demo renames placeholder images and rescales
the working camera between them. Errors are measured in normalized image
coordinates and reported in pixels at a shared reference focal length, so the
two snapshots stay comparable despite the resolution change.

Bundle adjustment is expected to reduce the reprojection error of those common
observations; comparing pixel error keeps the number interpretable and avoids a
point-cloud alignment step, which the VGGT sparse model does not need.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

Observation = tuple[int, int]


def _require_pycolmap():
    import pycolmap

    return pycolmap


def _read_model(path: Path):
    pycolmap = _require_pycolmap()
    return pycolmap.Reconstruction(str(path))


def _image_by_id(reconstruction: Any, image_id: int):
    """Return the image with the given id, or None; pycolmap's ImageMap has no ``get``."""
    try:
        return reconstruction.images[image_id]
    except (KeyError, IndexError):
        return None


def _point_by_id(reconstruction: Any, point3D_id: int):
    """Return the 3D point with the given id, or None."""
    try:
        return reconstruction.points3D[point3D_id]
    except (KeyError, IndexError):
        return None


def _camera_model(camera: Any) -> str:
    """Return the camera model name across pycolmap versions."""
    name = getattr(camera, "model_name", None)
    if isinstance(name, str):
        return name
    model = getattr(camera, "model", None)
    name = getattr(model, "name", model)
    return str(name)


def _focal(camera: Any) -> float:
    """Focal length in pixels for the camera models the pipeline writes."""
    params = list(camera.params)
    model = _camera_model(camera)
    if model in {"SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"}:
        return float(params[0])
    if model in {"PINHOLE", "OPENCV", "FULL_OPENCV"}:
        return float((params[0] + params[1]) / 2.0)
    raise ValueError(f"Unsupported camera model for diagnostics: {model}")


def _median_focal(reconstruction: Any) -> float:
    focals = [_focal(camera) for camera in reconstruction.cameras.values()]
    return float(np.median(focals)) if focals else 1.0


def _observed_points(reconstruction: Any) -> dict[Observation, np.ndarray]:
    """Map each tracked observation to its measured 2D location in pixels."""
    observed: dict[Observation, np.ndarray] = {}
    for point3D_id, point in reconstruction.points3D.items():
        for element in point.track.elements:
            image = _image_by_id(reconstruction, int(element.image_id))
            if image is None:
                continue
            try:
                xy = np.asarray(image.points2D[element.point2D_idx].xy, dtype=float).ravel()
            except (IndexError, KeyError):
                continue
            observed[(int(element.image_id), int(point3D_id))] = xy
    return observed


def _project(camera: Any, point: np.ndarray) -> np.ndarray | None:
    """Project a camera-space point with the models the pipeline writes."""
    params = [float(value) for value in camera.params]
    model = _camera_model(camera)
    if model in {"SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"}:
        fx = fy = params[0]
        cx, cy = params[1], params[2]
        distortion = params[3:]
    elif model in {"PINHOLE", "OPENCV", "FULL_OPENCV"}:
        fx, fy, cx, cy = params[:4]
        distortion = params[4:]
    else:
        raise ValueError(f"Unsupported camera model for diagnostics: {model}")
    if point[2] <= 0:
        return None
    x, y = point[0] / point[2], point[1] / point[2]
    radial = 1.0
    if model in {"SIMPLE_RADIAL", "RADIAL", "OPENCV", "FULL_OPENCV"} and distortion:
        squared = x * x + y * y
        radial = 1.0 + distortion[0] * squared
        if model != "SIMPLE_RADIAL" and len(distortion) > 1:
            radial += distortion[1] * squared * squared
    if model in {"OPENCV", "FULL_OPENCV"} and len(distortion) >= 4:
        tangential_x = 2 * distortion[2] * x * y + distortion[3] * (x * x + 3 * y * y)
        tangential_y = distortion[2] * (3 * x * x + y * y) + 2 * distortion[3] * x * y
        return np.array([fx * (x * radial + tangential_x) + cx, fy * (y * radial + tangential_y) + cy])
    return np.array([fx * x * radial + cx, fy * y * radial + cy])


def _project_point(image: Any, camera: Any, xyz: np.ndarray) -> np.ndarray | None:
    pose = image.cam_from_world
    if callable(pose):
        pose = pose()
    matrix = np.asarray(pose.matrix() if hasattr(pose, "matrix") else pose, dtype=float)
    camera_point = matrix[:3, :3] @ np.asarray(xyz, dtype=float) + matrix[:3, 3]
    return _project(camera, camera_point)


def _normalized_error(reconstruction: Any, image: Any, point3D_id: int, measured: np.ndarray) -> float | None:
    point = _point_by_id(reconstruction, point3D_id)
    if point is None:
        return None
    camera = reconstruction.cameras[image.camera_id]
    projected = _project_point(image, camera, point.xyz)
    if projected is None:
        return None
    focal = _focal(camera)
    delta = projected.ravel() - measured
    return float(math.hypot(delta[0] / focal, delta[1] / focal))


def _stats(errors: np.ndarray) -> dict[str, float | int | None]:
    if errors.size == 0:
        return {"mean": None, "median": None, "p95": None, "observations": 0}
    return {
        "mean": float(errors.mean()),
        "median": float(np.median(errors)),
        "p95": float(np.percentile(errors, 95)),
        "observations": int(errors.size),
    }


def projection_error_stats(
    reconstruction: Any,
    observations: dict[Observation, np.ndarray] | None = None,
    reference_focal: float | None = None,
):
    """Return reprojection error statistics in pixels at ``reference_focal``."""
    observations = _observed_points(reconstruction) if observations is None else observations
    reference_focal = _median_focal(reconstruction) if reference_focal is None else reference_focal
    errors: list[float] = []
    for (image_id, point3D_id), measured in observations.items():
        image = _image_by_id(reconstruction, image_id)
        if image is None:
            continue
        normalized = _normalized_error(reconstruction, image, point3D_id, measured)
        if normalized is not None:
            errors.append(normalized * reference_focal)
    return _stats(np.asarray(errors, dtype=float))


def _paired_errors(
    before_reconstruction: Any,
    after_reconstruction: Any,
    common: list[Observation],
    before_observations: dict[Observation, np.ndarray],
    after_observations: dict[Observation, np.ndarray],
    reference_focal: float,
) -> tuple[np.ndarray, np.ndarray]:
    before_errors: list[float] = []
    after_errors: list[float] = []
    for key in common:
        before_image = _image_by_id(before_reconstruction, key[0])
        after_image = _image_by_id(after_reconstruction, key[0])
        if before_image is None or after_image is None:
            continue
        before_normalized = _normalized_error(before_reconstruction, before_image, key[1], before_observations[key])
        after_normalized = _normalized_error(after_reconstruction, after_image, key[1], after_observations[key])
        if before_normalized is None or after_normalized is None:
            continue
        before_errors.append(before_normalized * reference_focal)
        after_errors.append(after_normalized * reference_focal)
    return np.asarray(before_errors, dtype=float), np.asarray(after_errors, dtype=float)


def compare_bundle_adjustment(before: Path, after: Path, output: Path) -> dict[str, object]:
    """Compare reprojection error of common observations before and after BA."""
    before_reconstruction = _read_model(Path(before))
    after_reconstruction = _read_model(Path(after))
    before_observations = _observed_points(before_reconstruction)
    after_observations = _observed_points(after_reconstruction)
    common = sorted(set(before_observations) & set(after_observations))
    reference_focal = _median_focal(after_reconstruction)
    before_array, after_array = _paired_errors(
        before_reconstruction, after_reconstruction, common, before_observations, after_observations, reference_focal
    )
    paired = before_array.size
    improved = float(np.mean(after_array < before_array)) if paired else None
    result: dict[str, object] = {
        "schema_version": 1,
        "before_path": str(before),
        "after_path": str(after),
        "reference_focal": reference_focal,
        "before": _stats(before_array),
        "after": _stats(after_array),
        "common_observations": paired,
        "improved_ratio": improved,
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
