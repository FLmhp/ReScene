"""Freeze one validation frame every N source images for reproducible holdout metrics.

Validation frames are defined on the **source** image sequence, not on a run's
selected frames: FAST keeps 80 frames while QUALITY keeps 250, so a per-run
definition would compare different images. Selection is deterministic
(sorted path order, every eighth image) and CPU only.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from rescene.preprocess import discover_images, source_id


def freeze(manifest_paths: list[Path], output_path: Path, every: int) -> dict[str, object]:
    if every < 1:
        raise ValueError("every must be at least 1")
    scenes: dict[str, object] = {}
    for manifest_path in manifest_paths:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for scene in manifest.get("scenes", []):
            scene_id = str(scene["id"])
            if scene_id in scenes:
                raise ValueError(f"Duplicate scene id across manifests: {scene_id}")
            input_path = Path(str(scene["input"]))
            if not input_path.is_dir():
                raise ValueError(f"Scene {scene_id} input is not an image directory: {input_path}")
            images = discover_images(input_path)
            ids = [source_id(input_path, path.resolve()) for path in images]
            if len(ids) != len(set(ids)):
                raise ValueError(f"Scene {scene_id} has duplicate canonical source IDs")
            frames = [
                {"source": str(path.resolve()), "source_id": identifier, "basename": path.name}
                for index, (path, identifier) in enumerate(zip(images, ids, strict=True))
                if index % every == 0
            ]
            if not frames:
                raise ValueError(f"Scene {scene_id} produced no validation frames")
            scenes[scene_id] = {
                "source": str(input_path),
                "frame_count": len(images),
                "frames": frames,
            }
    result: dict[str, object] = {
        "schema_version": 1,
        "every": every,
        "manifests": [str(path) for path in manifest_paths],
        "scenes": scenes,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--every", type=int, default=8)
    args = parser.parse_args()
    result = freeze(args.manifest, args.output, args.every)
    print(json.dumps({scene: len(value["frames"]) for scene, value in result["scenes"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
