"""Diagnose fixed multi-camera rig calibration on the frozen 160-view scenes."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

import numpy as np

from rescene.evaluation import pose_errors
from rescene.preprocess import preprocess_input, sha256_file


def load_rig_origins(reference) -> dict:
    geometries: dict[tuple[int, str], object] = {}
    for image in reference.images.values():
        path = Path(image.name)
        prefix = path.parent.name
        camera = int(prefix.removeprefix("images_rig_cam").removesuffix("_undistorted"))
        geometries[camera, path.stem] = image
    return geometries


def calibrated_offset(pycolmap, origins: dict, reference_camera: int, sensor: int):
    times = sorted(time for camera, time in origins if camera == reference_camera and (sensor, time) in origins)
    if len(times) < 3:
        raise ValueError(f"Rig sensor {sensor} has fewer than three synchronized calibration pairs")
    relatives = [
        origins[sensor, stamp].cam_from_world() * origins[reference_camera, stamp].cam_from_world().inverse()
        for stamp in times
    ]
    quaternions = np.array([pose.rotation.quat for pose in relatives])
    quaternions[quaternions @ quaternions[0] < 0] *= -1
    average = quaternions.mean(axis=0)
    translations = np.array([pose.translation for pose in relatives])
    center = np.median(translations, axis=0)
    return pycolmap.Rigid3d(pycolmap.Rotation3d(average / np.linalg.norm(average)), center), {
        "samples": len(times),
        "median_translation_residual_m": float(np.median(np.linalg.norm(translations - center, axis=1))),
    }


def estimate(dataset: Path, scene: str, reference_path: Path, work: Path, archive: Path) -> None:
    import pycolmap

    frozen = json.loads((dataset / "ready" / scene / "frozen.json").read_text())
    spec = frozen["subsets"]["160"]
    sources = spec["selected_sources"]
    held_out = {sources[index] for index in spec["validation"]["sources"]}
    source = dataset / "ready" / scene / "160"
    for name, digest in spec["source_sha256"].items():
        if sha256_file(source / name) != digest:
            raise ValueError(f"Frozen ETH3D source differs: {name}")
    prepared = work / "normalized-run"
    manifest = preprocess_input(
        source,
        prepared,
        scene=scene,
        max_frames=160,
        validation_sources=held_out,
        retain_frozen_sources=True,
        record_hashes=True,
    )
    reference = pycolmap.Reconstruction(reference_path)
    originals = load_rig_origins(reference)
    images = work / "images"
    paths = {}
    cameras = {}
    for frame in manifest["frames"]:
        item = frozen["selected_source_origins"][frame["source_id"]]
        sensor = item["camera"]
        timestamp = Path(item["path"]).stem
        original = originals[sensor, timestamp]
        relative = Path(f"camera{sensor:02d}") / f"{timestamp}.jpg"
        destination = images / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.link(frame["file"], destination)
        paths[relative.as_posix()] = (original, frame["source_id"])
        camera = pycolmap.Camera(original.camera.todict())
        camera.rescale(frame["width"], frame["height"])
        if sensor in cameras:
            saved = cameras[sensor]
            if (camera.width, camera.height) != (saved.width, saved.height) or not np.allclose(
                camera.params, saved.params
            ):
                raise ValueError(f"Sensor {sensor} does not have constant normalized intrinsics")
        cameras[sensor] = camera
    sensor_reference = min(cameras)
    configuration = []
    offsets = {}
    for sensor, camera in sorted(cameras.items()):
        offset = None
        if sensor != sensor_reference:
            offset, offsets[sensor] = calibrated_offset(pycolmap, originals, sensor_reference, sensor)
        configuration.append(
            pycolmap.RigConfigCamera(
                image_prefix=f"camera{sensor:02d}/",
                ref_sensor=sensor == sensor_reference,
                cam_from_rig=offset,
                camera=camera,
            )
        )
    pycolmap.set_random_seed(42)
    database = work / "matches.db"
    reader = pycolmap.ImageReaderOptions(camera_model="PINHOLE")
    pycolmap.extract_features(
        database,
        images,
        camera_mode=pycolmap.CameraMode.PER_FOLDER,
        reader_options=reader,
        device=pycolmap.Device.cuda,
    )
    with pycolmap.Database.open(database) as db:
        pycolmap.apply_rig_config([pycolmap.RigConfig(cameras=configuration)], db)
        groups = {"rigs": db.num_rigs(), "frames": db.num_frames(), "cameras": db.num_cameras()}
    if groups["rigs"] != 1 or groups["frames"] != len({Path(name).stem for name in paths}):
        raise ValueError(f"Unexpected calibrated rig grouping: {groups}")
    pycolmap.match_exhaustive(database, device=pycolmap.Device.cuda)
    options = pycolmap.IncrementalPipelineOptions(
        ba_refine_sensor_from_rig=False,
        ba_refine_focal_length=False,
        ba_refine_extra_params=False,
    )
    maps = pycolmap.incremental_mapping(database, images, work / "sparse", options=options)
    if not maps:
        raise RuntimeError("Calibrated rig did not register a model")
    model = max(maps.values(), key=lambda row: row.num_reg_images())
    pairs = [(image, *paths[image.name]) for image in model.images.values() if image.has_pose]
    supported = {source_id for image, _, source_id in pairs if image.num_points3D > 0} & held_out
    centers = [np.array([pair[index].projection_center() for pair in pairs]) for index in (0, 1)]
    rotations = [np.array([pair[index].cam_from_world().rotation.matrix() for pair in pairs]) for index in (0, 1)]
    ate, rotation_error, _ = pose_errors(*centers, *rotations)
    result = {
        "scene": scene,
        "registered": len(pairs),
        "selected": len(sources),
        "groups": groups,
        "held_out": sorted(held_out),
        "supported": sorted(supported),
        "sparse_points_by_source": {source_id: image.num_points3D for image, _, source_id in pairs},
        "relative_calibration": offsets,
        "pose_ate_m": ate,
        "pose_rotation_error_deg": rotation_error,
        "official_absolute_poses_used_only_for_evaluation": True,
    }
    (archive / "result.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    model.write(archive)
    print(json.dumps(result, allow_nan=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("scene", choices=("delivery_area", "playground"))
    parser.add_argument("reference", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    args.archive.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="rescene-calibrated-rig-") as path:
        estimate(args.dataset, args.scene, args.reference, Path(path), args.archive)


if __name__ == "__main__":
    main()
