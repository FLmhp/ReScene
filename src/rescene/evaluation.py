"""Post-hoc evaluation against a reference COLMAP model and point cloud."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

from rescene.coordinate_frames import artifact_to_colmap
from rescene.metrics import (
    EVALUATION_FIELDS,
    _photometric_metrics,
    collect_metrics,
    evaluation_artifacts,
    final_ply_path,
    sha256_file,
    write_report,
)

SPATIAL_RANK_TOLERANCE = 1e-9


def _require_spatial_span(centered: np.ndarray, side: str) -> None:
    """Reject layouts that cannot define a rotation.

    Two independent directions keep planar captures valid; a line, a point, or
    non-finite coordinates cannot.
    """
    if not np.all(np.isfinite(centered)):
        raise ValueError(f"{side} camera positions must be finite")
    largest = float(np.abs(centered).max()) if centered.size else 0.0
    if largest <= np.finfo(float).eps:
        raise ValueError(f"{side} camera positions are degenerate")
    singular = np.linalg.svd(centered, compute_uv=False)
    if int(np.count_nonzero(singular > largest * SPATIAL_RANK_TOLERANCE)) < 2:
        raise ValueError(f"{side} camera positions do not span two independent directions")


def similarity_alignment(source: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Return the least-squares similarity transform from source to target."""
    if source.shape != target.shape or source.ndim != 2 or source.shape[1] != 3 or len(source) < 3:
        raise ValueError("At least three paired 3D positions are required")
    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    _require_spatial_span(source_centered, "Predicted")
    _require_spatial_span(target_centered, "Reference")
    covariance = target_centered.T @ source_centered / len(source)
    left, singular, right = np.linalg.svd(covariance)
    signs = np.ones(3)
    signs[-1] = np.sign(np.linalg.det(left @ right))
    rotation = left @ np.diag(signs) @ right
    variance = np.sum(source_centered**2) / len(source)
    if variance <= np.finfo(float).eps:
        raise ValueError("Predicted camera positions are degenerate")
    scale = float(np.sum(singular * signs) / variance)
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("Similarity scale must be positive and finite")
    translation = target_mean - scale * (rotation @ source_mean)
    return scale, rotation, translation


def pose_errors(
    predicted_centers: np.ndarray,
    target_centers: np.ndarray,
    predicted_rotations: np.ndarray,
    target_rotations: np.ndarray,
) -> tuple[float, float, tuple[float, np.ndarray, np.ndarray]]:
    scale, rotation, translation = similarity_alignment(predicted_centers, target_centers)
    aligned = scale * (predicted_centers @ rotation.T) + translation
    ate = float(np.sqrt(np.mean(np.sum((aligned - target_centers) ** 2, axis=1))))
    aligned_rotations = predicted_rotations @ rotation.T
    relative = target_rotations @ np.swapaxes(aligned_rotations, 1, 2)
    cosine = np.clip((np.trace(relative, axis1=1, axis2=2) - 1) / 2, -1, 1)
    rotation_error = float(np.degrees(np.arccos(cosine)).mean())
    return ate, rotation_error, (scale, rotation, translation)


def _read_ply_xyz(path: Path, maximum: int | None = None) -> np.ndarray:
    scalar_types = {
        "char": "i1",
        "uchar": "u1",
        "int8": "i1",
        "uint8": "u1",
        "short": "i2",
        "ushort": "u2",
        "int16": "i2",
        "uint16": "u2",
        "int": "i4",
        "uint": "u4",
        "int32": "i4",
        "uint32": "u4",
        "float": "f4",
        "float32": "f4",
        "double": "f8",
        "float64": "f8",
    }
    with path.open("rb") as stream:
        header: list[str] = []
        while True:
            line = stream.readline()
            if not line:
                raise ValueError(f"Invalid PLY header: {path}")
            decoded = line.decode("ascii").strip()
            header.append(decoded)
            if decoded == "end_header":
                break
        data_offset = stream.tell()
    format_line = next((line for line in header if line.startswith("format ")), "")
    vertex_line = next((line for line in header if line.startswith("element vertex ")), "")
    if not format_line or not vertex_line:
        raise ValueError(f"PLY has no vertex data: {path}")
    vertex_count = int(vertex_line.split()[2])
    vertex_index = header.index(vertex_line)
    properties: list[tuple[str, str]] = []
    for line in header[vertex_index + 1 :]:
        if line.startswith("element ") or line == "end_header":
            break
        parts = line.split()
        if parts[:1] == ["property"]:
            if len(parts) != 3 or parts[1] not in scalar_types:
                raise ValueError(f"Unsupported vertex property in {path}: {line}")
            properties.append((parts[2], scalar_types[parts[1]]))
    names = [name for name, _ in properties]
    if not {"x", "y", "z"}.issubset(names):
        raise ValueError(f"PLY vertex data has no x/y/z properties: {path}")
    if format_line.startswith("format ascii"):
        values = np.loadtxt(
            path, skiprows=len(header), max_rows=vertex_count, usecols=[names.index(axis) for axis in "xyz"]
        )
        values = np.asarray(values, dtype=np.float64).reshape(-1, 3)
        return _sample(values, maximum) if maximum else values
    byte_order = "<" if format_line.startswith("format binary_little_endian") else ">"
    if not format_line.startswith(("format binary_little_endian", "format binary_big_endian")):
        raise ValueError(f"Unsupported PLY format: {format_line}")
    dtype = np.dtype([(name, byte_order + kind) for name, kind in properties])
    vertices = np.memmap(path, dtype=dtype, mode="r", offset=data_offset, shape=(vertex_count,))
    if maximum and vertex_count > maximum:
        vertices = vertices[np.linspace(0, vertex_count - 1, maximum, dtype=np.int64)]
    return np.column_stack([vertices[axis] for axis in "xyz"]).astype(np.float64)


def _read_reference_cloud(path: Path, maximum: int = 1_000_000) -> np.ndarray:
    if path.suffix.casefold() != ".mlp":
        return _read_ply_xyz(path, maximum)
    meshes = ElementTree.parse(path).findall(".//MLMesh")
    if not meshes:
        raise ValueError(f"MeshLab project contains no point clouds: {path}")
    clouds = []
    per_mesh = max(1, maximum // len(meshes))
    for mesh in meshes:
        matrix_node = mesh.find("MLMatrix44")
        filename = mesh.get("filename")
        if matrix_node is None or not matrix_node.text or not filename:
            raise ValueError(f"Invalid MeshLab point-cloud entry in {path}")
        matrix = np.fromstring(matrix_node.text, sep=" ").reshape(4, 4)
        points = _read_ply_xyz(path.parent / filename, per_mesh)
        clouds.append(points @ matrix[:3, :3].T + matrix[:3, 3])
    return np.concatenate(clouds)


def point_errors(predicted: np.ndarray, target: np.ndarray, threshold: float) -> tuple[float, float, float]:
    if threshold <= 0 or not len(predicted) or not len(target):
        raise ValueError("Non-empty point clouds and a positive threshold are required")
    try:
        from scipy.spatial import cKDTree
    except ImportError as error:
        raise RuntimeError("Point-cloud evaluation requires scipy") from error
    predicted_distances = cKDTree(target).query(predicted, workers=-1)[0]
    target_distances = cKDTree(predicted).query(target, workers=-1)[0]
    precision = float(np.mean(predicted_distances <= threshold))
    recall = float(np.mean(target_distances <= threshold))
    fscore = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return float(predicted_distances.mean()), float(target_distances.mean()), fscore


def _sample(points: np.ndarray, maximum: int = 1_000_000) -> np.ndarray:
    if len(points) <= maximum:
        return points
    return points[np.linspace(0, len(points) - 1, maximum, dtype=np.int64)]


def _write_ply_xyz(path: Path, points: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
    )
    with path.open("wb") as stream:
        stream.write(header.encode("ascii"))
        np.asarray(points, dtype="<f4").tofile(stream)


def _parse_official_scores(output: str) -> tuple[float, float, float]:
    def value(label: str) -> float:
        line = next((line for line in output.splitlines() if line.startswith(label)), None)
        if line is None:
            raise ValueError(f"ETH3D evaluator output has no {label.rstrip(':')}")
        values = line.split(":", 1)[1].split()
        if len(values) != 1:
            raise ValueError("ETH3D evaluation expects exactly one tolerance")
        return float(values[0])

    return value("Accuracies:"), value("Completenesses:"), value("F1-scores:")


def _official_point_scores(
    evaluator: Path, reconstruction: Path, ground_truth_mlp: Path, threshold: float, log_path: Path
) -> tuple[float, float, float]:
    if not evaluator.is_file():
        raise FileNotFoundError(evaluator)
    if ground_truth_mlp.suffix.casefold() != ".mlp":
        raise ValueError("The official ETH3D evaluator requires a MeshLab .mlp ground-truth project")
    result = subprocess.run(
        [
            str(evaluator),
            "--reconstruction_ply_path",
            str(reconstruction),
            "--ground_truth_mlp_path",
            str(ground_truth_mlp),
            "--tolerances",
            str(threshold),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    result.check_returncode()
    return _parse_official_scores(result.stdout)


def evaluate_run(
    run_dir: Path,
    ground_truth_sparse: Path | None,
    ground_truth_cloud: Path | None = None,
    threshold: float = 0.02,
    official_evaluator: Path | None = None,
    *,
    reference_image_prefix: str = "",
    persist: bool = True,
) -> dict[str, object]:
    metrics_path = run_dir / "metrics.json"
    metrics = (
        json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.is_file() else collect_metrics(run_dir)
    )
    if metrics_path.is_file() and (run_dir / "gsplat").exists():
        final_ply_path(run_dir)
        metrics.update(_photometric_metrics(run_dir))
    if ground_truth_cloud is not None and ground_truth_sparse is None:
        raise ValueError("Point-cloud evaluation requires a reference COLMAP model for alignment")
    scale, rotation, translation = 1.0, np.eye(3), np.zeros(3, dtype=np.float64)
    if ground_truth_sparse is not None:
        try:
            import pycolmap
        except ImportError as error:
            raise RuntimeError("Evaluation requires pycolmap") from error

        split_path = run_dir / "photometric_split.json"
        split = json.loads(split_path.read_text(encoding="utf-8"))
        source_names = split["image_to_source_id"]
        if (
            not isinstance(source_names, dict)
            or any(
                not isinstance(name, str) or not isinstance(source_id, str) or not source_id
                for name, source_id in source_names.items()
            )
            or len(set(source_names.values())) != len(source_names)
        ):
            raise ValueError("Invalid source identity mapping")
        sparse = run_dir / "sparse" / "0"
        if not sparse.is_dir():
            sparse = run_dir / "sparse"
        predicted = pycolmap.Reconstruction(sparse)
        target = pycolmap.Reconstruction(ground_truth_sparse)
        target_images = {image.name: image for image in target.images.values()}
        pairs = [
            (image, target_images[reference_image_prefix + source_names[image.name]])
            for image in predicted.images.values()
            if image.name in source_names and reference_image_prefix + source_names[image.name] in target_images
        ]
        if len(pairs) < 3:
            raise ValueError(f"Only {len(pairs)} camera poses match the reference model")
        predicted_centers = np.asarray([pair[0].projection_center() for pair in pairs])
        target_centers = np.asarray([pair[1].projection_center() for pair in pairs])
        predicted_rotations = np.asarray([pair[0].cam_from_world().rotation.matrix() for pair in pairs])
        target_rotations = np.asarray([pair[1].cam_from_world().rotation.matrix() for pair in pairs])
        ate, rotation_error, (scale, rotation, translation) = pose_errors(
            predicted_centers, target_centers, predicted_rotations, target_rotations
        )
        metrics.update(
            {
                "pose_ate": ate,
                "pose_rotation_error": rotation_error,
                "evaluation_registered_images": len(pairs),
            }
        )
    if ground_truth_cloud is not None:
        dense = run_dir / "dense" / "fused.ply"
        predicted_cloud_path = dense if dense.is_file() else final_ply_path(run_dir)
        maximum = None if official_evaluator else 1_000_000
        predicted_points = _read_ply_xyz(predicted_cloud_path, maximum)
        artifact_transform, artifact_frame = artifact_to_colmap(run_dir, predicted_cloud_path)
        colmap_to_gt = np.eye(4, dtype=np.float64)
        colmap_to_gt[:3, :3] = scale * rotation
        colmap_to_gt[:3, 3] = translation
        transform = colmap_to_gt @ artifact_transform
        predicted_points = predicted_points @ transform[:3, :3].T + transform[:3, 3]
        metrics["evaluation_point_cloud_frame"] = artifact_frame
        metrics["evaluation_artifact_to_reference"] = transform.tolist()
        if official_evaluator is None:
            if ground_truth_sparse is None:
                raise ValueError("Proxy point-cloud evaluation requires ground_truth_sparse for alignment")
            target_points = _read_reference_cloud(ground_truth_cloud)
            proxy_accuracy, proxy_completeness, proxy_fscore = point_errors(
                _sample(predicted_points), target_points, threshold
            )
            metrics.update(
                {
                    "point_accuracy": proxy_accuracy,
                    "point_completeness": proxy_completeness,
                    "point_fscore": proxy_fscore,
                    "point_accuracy_distance": proxy_accuracy,
                    "point_completeness_distance": proxy_completeness,
                    "point_fscore_proxy": proxy_fscore,
                    "point_threshold": threshold,
                    "point_metric_method": "nearest_neighbor_proxy",
                    "evaluation_point_cloud": str(predicted_cloud_path),
                }
            )
        else:
            aligned_path = run_dir / "evaluation" / "aligned-reconstruction.ply"
            _write_ply_xyz(aligned_path, predicted_points)
            accuracy, completeness, fscore = _official_point_scores(
                official_evaluator,
                aligned_path,
                ground_truth_cloud,
                threshold,
                run_dir / "evaluation" / "eth3d-official.log",
            )
            metrics.update(
                {
                    "point_accuracy": accuracy,
                    "point_completeness": completeness,
                    "point_fscore": fscore,
                    "point_threshold": threshold,
                    "point_metric_method": "eth3d_official",
                    "evaluation_point_cloud": str(aligned_path),
                    "official_evaluator_sha256": sha256_file(official_evaluator),
                }
            )
    fields = {name: metrics[name] for name in EVALUATION_FIELDS if name in metrics}
    if fields:
        metrics["evaluation_evidence"] = {
            "schema_version": 1,
            "artifacts": evaluation_artifacts(run_dir),
            "fields": fields,
        }
    if persist:
        metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        write_report(run_dir, metrics)
    return metrics
