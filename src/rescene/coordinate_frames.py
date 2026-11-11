"""Coordinate frame metadata for reconstructed artifacts.

Matrices act on column vectors: ``colmap_to_trainer @ [x, y, z, 1]``.
Artifact paths in the manifest are relative to the run directory; a directory
entry declares the frame of all artifacts beneath it.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

import numpy as np


def _matrix(value: object, name: str) -> np.ndarray:
    try:
        matrix = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Invalid {name} matrix") from error
    if (
        matrix.shape != (4, 4)
        or not np.isfinite(matrix).all()
        or not np.allclose(matrix[3], [0, 0, 0, 1], rtol=0, atol=1e-7)
    ):
        raise ValueError(f"Invalid {name} matrix: expected a finite affine 4x4 matrix")
    return matrix


def artifact_to_colmap(run_dir: Path, artifact_path: Path) -> tuple[np.ndarray, str]:
    """Return the selected artifact's transform to COLMAP and its declared frame.

    Missing or inconsistent frame metadata is an error, including for legacy
    runs: silently treating a normalized trainer artifact as COLMAP is unsafe.
    """
    manifest_path = run_dir / "geometry_frames.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"Coordinate frame metadata is missing: {manifest_path}") from error
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"Invalid coordinate frame metadata: {manifest_path}") from error
    if not isinstance(manifest, dict):
        raise ValueError("Coordinate frame metadata must be an object")
    forward = _matrix(manifest.get("colmap_to_trainer"), "colmap_to_trainer")
    inverse = _matrix(manifest.get("trainer_to_colmap"), "trainer_to_colmap")
    if not (
        np.allclose(forward @ inverse, np.eye(4), rtol=1e-5, atol=1e-5)
        and np.allclose(inverse @ forward, np.eye(4), rtol=1e-5, atol=1e-5)
    ):
        raise ValueError("COLMAP and trainer transforms are not inverses")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError("Coordinate frame metadata must declare artifacts")
    try:
        relative = artifact_path.resolve().relative_to(run_dir.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"Artifact is outside the run directory: {artifact_path}") from error
    matches: list[tuple[int, str]] = []
    for key, frame in artifacts.items():
        if not isinstance(key, str) or not key or "\\" in key:
            raise ValueError("Invalid artifact path in coordinate frame metadata")
        path = PurePosixPath(key)
        if path.is_absolute() or any(part in (".", "..") for part in path.parts) or path.as_posix() != key:
            raise ValueError(f"Invalid artifact path in coordinate frame metadata: {key}")
        if frame not in ("trainer", "colmap"):
            raise ValueError(f"Unknown coordinate frame for {key}: {frame}")
        if relative == key or relative.startswith(key + "/"):
            matches.append((len(path.parts), frame))
    if not matches:
        raise ValueError(f"No coordinate frame declared for artifact: {relative}")
    frame = max(matches, key=lambda match: match[0])[1]
    return (inverse if frame == "trainer" else np.eye(4)), frame
