"""Freeze nested many-view inputs and an explicit validation split on CPU."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path

from rescene.preprocess import discover_images, preprocess_input


def stage_rig(images: Path, flat: Path) -> dict[str, dict]:
    """Keep camera identity and timestamp when flattening the official ETH3D rig layout."""
    flat.mkdir()
    origins = {}
    for path in sorted(images.glob("images_rig_cam*_undistorted/*.png")):
        camera = re.fullmatch(r"images_rig_cam(\d+)_undistorted", path.parent.name)
        if camera is None or not path.stem.isdecimal():
            raise ValueError(f"Unexpected ETH3D image path: {path}")
        name = f"{int(path.stem):020d}_cam{int(camera[1]):02d}.png"
        target = flat / name
        try:
            target.hardlink_to(path)
        except OSError:
            shutil.copy2(path, target)
        origins[name] = {
            "camera": int(camera[1]),
            "timestamp_ns": int(path.stem),
            "path": path.relative_to(images).as_posix(),
        }
    if not origins:
        raise ValueError("No undistorted ETH3D rig images found")
    return origins


def evenly_spaced(sources: list[str], count: int) -> list[str]:
    if not 0 <= count <= len(sources):
        raise ValueError(f"Requested {count} frames with only {len(sources)} available")
    selected = []
    cameras = sorted({name.split("_cam", 1)[1].split(".", 1)[0] for name in sources if "_cam" in name})
    for index in range(count):
        start, stop = index * len(sources) // count, (index + 1) * len(sources) // count
        middle = (start + stop) // 2
        if cameras:
            camera = f"_cam{cameras[index % len(cameras)]}."
            ranked = sorted(range(start, stop), key=lambda position: (abs(position - middle), position))
            middle = next((position for position in ranked if camera in sources[position]), middle)
        selected.append(sources[middle])
    return selected


def freeze(scene: Path, output: Path, sizes: list[int], validation_count: int = 8, *, eth3d_rig: bool = False) -> dict:
    scene = scene.resolve()
    output = output.resolve()
    if output.exists() or output.is_relative_to(scene):
        raise ValueError("Choose a new, separate output directory")
    if not sizes or min(sizes) <= validation_count or validation_count < 1:
        raise ValueError("Every frame budget must leave room for training views")
    with tempfile.TemporaryDirectory(prefix="rescene-freeze-") as temporary:
        source_root = scene
        origins = {}
        if eth3d_rig:
            source_root = Path(temporary) / "flat"
            origins = stage_rig(scene, source_root)
        survey = preprocess_input(
            source_root,
            Path(temporary) / "preprocessed",
            scene=scene.parent.name if eth3d_rig else scene.name,
            max_frames=len(discover_images(source_root)),
            record_hashes=True,
        )
    source_hashes = {frame["source_id"]: frame["source_sha256"] for frame in survey["frames"]}
    eligible = [
        frame["source_id"] for frame in survey["frames"] if not frame["duplicate"] and not frame["quality_rejected"]
    ]
    if len(eligible) < max(sizes):
        raise ValueError(f"Expected at least {max(sizes)} eligible unique views, found {len(eligible)}")
    validation = set(evenly_spaced(eligible, validation_count))
    selected = validation.copy()
    subsets = {}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".rescene-manyview-", dir=output.parent) as temporary:
        workspace = Path(temporary) / output.name
        for size in sorted(set(sizes)):
            selected.update(evenly_spaced([item for item in eligible if item not in selected], size - len(selected)))
            ordered = sorted(selected)
            destination = workspace / str(size)
            destination.mkdir(parents=True)
            for name in ordered:
                target = destination / name
                source = scene / origins[name]["path"] if eth3d_rig else scene / name
                try:
                    target.hardlink_to(source)
                except OSError:
                    shutil.copy2(source, target)
            subsets[str(size)] = {
                "scene": str(output / str(size)),
                "scene_id": scene.parent.name if eth3d_rig else scene.name,
                "frame_limit": size,
                "selected_sources": ordered,
                "source_sha256": {name: source_hashes[name] for name in ordered},
                "validation": {"sources": [index for index, name in enumerate(ordered) if name in validation]},
            }
        result = {
            "source_root": str(scene),
            "ordering": "relative-filename",
            "source_count": len(source_hashes),
            "eligible_count": len(eligible),
            "validation_source_ids": sorted(validation),
            "subsets": subsets,
        }
        if origins:
            result["selected_source_origins"] = {name: origins[name] for name in sorted(selected)}
        (workspace / "frozen.json").write_text(
            json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        workspace.rename(output)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path, help="Flat directory, source names sorted in capture order")
    parser.add_argument("output", type=Path)
    parser.add_argument("--sizes", nargs="+", type=int, default=[64, 80, 160, 250])
    parser.add_argument("--validation-count", type=int, default=8)
    parser.add_argument(
        "--eth3d-rig", action="store_true", help="Input directory contains images_rig_cam*_undistorted subdirectories"
    )
    args = parser.parse_args()
    frozen = freeze(args.scene, args.output, args.sizes, args.validation_count, eth3d_rig=args.eth3d_rig)
    print(json.dumps({"output": str(args.output / "frozen.json"), "eligible_views": frozen["eligible_count"]}))
