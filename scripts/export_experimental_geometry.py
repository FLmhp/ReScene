"""Adapt independently inferred point maps and calibrated poses to COLMAP text."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image


def reprojection_errors(
    intrinsics: np.ndarray, cam_from_world: np.ndarray, points: np.ndarray, pixels: np.ndarray
) -> np.ndarray:
    if intrinsics.shape != (3, 3) or cam_from_world.shape != (4, 4) or points.ndim != 2 or points.shape[1] != 3:
        raise ValueError("Expected a pinhole camera, a 4×4 world-to-camera pose, and per-view 3D points")
    if points.shape[0] < 4 or pixels.shape != (len(points), 2):
        raise ValueError("Expected at least four point/pixel pairs per image")
    if any(not np.isfinite(array).all() for array in (intrinsics, cam_from_world, points, pixels)):
        raise ValueError("Geometry contains non-finite coordinates")
    rotation = cam_from_world[:3, :3]
    if (
        not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-4)
        or not np.isclose(np.linalg.det(rotation), 1, atol=1e-4)
        or not np.allclose(cam_from_world[3], (0, 0, 0, 1), atol=1e-4)
    ):
        raise ValueError("Pose must be a proper rigid world-to-camera transform")
    if (
        min(intrinsics[0, 0], intrinsics[1, 1]) <= 0
        or not np.allclose(intrinsics[2], (0, 0, 1))
        or not np.allclose(intrinsics[[0, 1], [1, 0]], 0)
    ):
        raise ValueError("Invalid COLMAP PINHOLE intrinsics")
    camera_points = points @ rotation.T + cam_from_world[:3, 3]
    if np.any(camera_points[:, 2] <= 0):
        raise ValueError("Point map contains observations behind the camera")
    homogeneous = camera_points @ intrinsics.T
    return np.linalg.norm(homogeneous[:, :2] / homogeneous[:, 2:] - pixels, axis=1)


def export_geometry(predictions: Path, scene: Path) -> dict:
    import pycolmap

    with np.load(predictions, allow_pickle=False) as bundle:
        names = bundle["image_names"].tolist()
        intrinsics = bundle["intrinsics"]
        poses = bundle["cam_from_world"]
        points = bundle["points"]
        colors = bundle["colors"]
        image_ids = bundle["image_indices"]
        pixels = bundle["pixels"]
    if (
        not isinstance(names, list)
        or len(names) < 2
        or any(
            not isinstance(name, str) or not re.fullmatch(r"[\w.-]+\.(jpg|jpeg|png)", name, re.IGNORECASE)
            for name in names
        )
    ):
        raise ValueError("Expected at least two normalized image names")
    if len(set(names)) != len(names) or intrinsics.shape != (len(names), 3, 3) or poses.shape != (len(names), 4, 4):
        raise ValueError("Each source image needs one unique calibrated pose")
    if (
        points.ndim != 2
        or points.shape[1] != 3
        or colors.shape != points.shape
        or colors.dtype != np.uint8
        or pixels.shape != (len(points), 2)
        or image_ids.shape != (len(points),)
        or image_ids.dtype.kind not in "iu"
        or np.any(image_ids < 0)
        or np.any(image_ids >= len(names))
    ):
        raise ValueError("Invalid correspondence arrays")
    cameras = []
    images = []
    per_view = {}
    for index, (name, camera, pose) in enumerate(zip(names, intrinsics, poses, strict=True)):
        with Image.open(scene / "images" / name) as image:
            width, height = image.size
        mask = image_ids == index
        observed = pixels[mask]
        errors = reprojection_errors(camera, pose, points[mask], observed)
        p90 = float(np.percentile(errors, 90))
        if p90 > 4 or np.any(observed < 0) or np.any(observed >= (width, height)):
            raise ValueError(f"Projection mismatch for {name}: p90={p90:.3f}px")
        camera_id = index + 1
        cameras.append(
            f"{camera_id} PINHOLE {width} {height} {camera[0, 0]} {camera[1, 1]} {camera[0, 2]} {camera[1, 2]}"
        )
        x, y, z, w = pycolmap.Rotation3d(pose[:3, :3]).quat
        tx, ty, tz = pose[:3, 3]
        images.append(f"{camera_id} {w} {x} {y} {z} {tx} {ty} {tz} {camera_id} {name}\n")
        per_view[name] = {"observations": int(mask.sum()), "reprojection_p90_px": p90}

    sparse = scene / "sparse" / "0"
    sparse.mkdir(parents=True, exist_ok=False)
    (sparse / "cameras.txt").write_text("\n".join(cameras) + "\n", encoding="utf-8")
    (sparse / "images.txt").write_text("\n".join(images) + "\n", encoding="utf-8")
    # Native point maps initialize Gaussians without inventing multi-view BA tracks.
    with (sparse / "points3D.txt").open("w", encoding="utf-8") as stream:
        for index, (point, color) in enumerate(zip(points, colors, strict=True), 1):
            stream.write(f"{index} {' '.join(map(str, point))} {' '.join(map(str, color))} -1\n")
    reconstruction = pycolmap.Reconstruction(sparse)
    if reconstruction.num_reg_images() != len(names) or reconstruction.num_points3D() != len(points):
        raise ValueError("COLMAP reload did not preserve geometry")
    return {"registered": len(names), "points": len(points), "views": per_view}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predictions", type=Path)
    parser.add_argument("scene", type=Path)
    args = parser.parse_args()
    print(json.dumps(export_geometry(args.predictions, args.scene), indent=2))
