"""Run the pinned gsplat trainer with an explicit, auditable holdout split."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

from rescene.metrics import allows_missing_validation


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def registered_split(manifest: dict, image_names: list[str], scene: Path, *, allow_missing: bool = False) -> dict:
    """Map registered COLMAP images to the selected source-level split."""
    frames = [frame for frame in manifest["frames"] if frame["selected"]]
    mapping = {Path(frame["file"]).relative_to(scene / "images").as_posix(): frame for frame in frames}
    if len(mapping) != len(frames) or len(set(image_names)) != len(image_names):
        raise ValueError("Duplicate image names in photometric split")
    if any(name not in mapping for name in image_names):
        raise ValueError("Registered image is absent from the input manifest")
    by_image = {name: mapping[name]["source_id"] for name in image_names}
    if len(set(by_image.values())) != len(by_image):
        raise ValueError("Duplicate source IDs in photometric split")
    train = [by_image[name] for name in image_names if not mapping[name]["validation"]]
    val = [by_image[name] for name in image_names if mapping[name]["validation"]]
    expected_val = {frame["source_id"] for frame in frames if frame["validation"]}
    missing = expected_val - set(val)
    if missing and (not allow_missing or len(expected_val) != 8 or len(missing) != 1):
        raise ValueError("Selected validation sources are missing from registered images")
    if not train or not val or set(train) & set(val):
        raise ValueError("Photometric split requires disjoint, nonempty registered train and validation sets")
    result = {
        "schema_version": 1,
        "train_source_ids": train,
        "validation_source_ids": val,
        "image_to_source_id": by_image,
    }
    if missing:
        result["missing_validation_source_ids"] = sorted(missing)
    return result


def _dense_parser(original_parser: object):
    """Replace sparse initialization points with validated, sampled dense points."""

    class DenseParser(original_parser):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            dense = Path(self.data_dir) / "dense" / "fused.ply"
            if not dense.is_file():
                raise ValueError(f"Dense initialization requires {dense}")
            import numpy as np
            from datasets.normalize import transform_points
            from plyfile import PlyData

            vertex = PlyData.read(str(dense))["vertex"].data
            xyz = np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1).astype(np.float32)
            rgb = np.stack([vertex["red"], vertex["green"], vertex["blue"]], axis=1).astype(np.uint8)
            finite = np.isfinite(xyz).all(axis=1)
            xyz, rgb = xyz[finite], rgb[finite]
            lower, upper = np.percentile(xyz, [0.5, 99.5], axis=0)
            inside = ((xyz >= lower) & (xyz <= upper)).all(axis=1)
            xyz, rgb = xyz[inside], rgb[inside]
            if len(xyz) < 100:
                raise ValueError("Dense initialization has too few valid points")
            limit = 250_000
            if len(xyz) > limit:
                index = np.linspace(0, len(xyz) - 1, limit).astype(np.int64)
                xyz, rgb = xyz[index], rgb[index]
            self.points = transform_points(np.asarray(self.transform), xyz)
            self.points_rgb = rgb

    return DenseParser


def configure_trainer(trainer: object, split_file: Path, init_points: str = "sparse") -> None:
    """Install split and per-view evaluation hooks on the pinned trainer."""
    import imageio.v2 as imageio
    import numpy as np
    import torch

    if init_points == "dense":
        trainer.Parser = _dense_parser(trainer.Parser)
    elif init_points != "sparse":
        raise ValueError(f"Unsupported init points: {init_points}")
    original_dataset = trainer.Dataset
    original_runner = trainer.Runner

    class SplitDataset(original_dataset):
        def __init__(self, parser, split="train", **kwargs):
            super().__init__(parser, split=split, **kwargs)
            scene = Path(parser.data_dir)
            manifest = json.loads((scene / "input_manifest.json").read_text(encoding="utf-8"))
            selection = json.loads(split_file.read_text(encoding="utf-8"))
            frames = [frame for frame in manifest["frames"] if frame["selected"]]
            expected_selection = {
                "schema_version": 1,
                "train_source_ids": [frame["source_id"] for frame in frames if not frame["validation"]],
                "validation_source_ids": [frame["source_id"] for frame in frames if frame["validation"]],
                "image_to_source_id": {
                    Path(frame["file"]).relative_to(scene / "images").as_posix(): frame["source_id"] for frame in frames
                },
            }
            if selection != expected_selection or len(selection["image_to_source_id"]) != len(frames):
                raise ValueError("Persisted photometric selection does not match input manifest")
            selected_ids = selection["train_source_ids"] + selection["validation_source_ids"]
            if len(set(selected_ids)) != len(selected_ids):
                raise ValueError("Photometric selection has duplicate or leaking source IDs")
            specification = registered_split(
                manifest, list(parser.image_names), scene, allow_missing=allows_missing_validation(scene)
            )
            split_path = scene / "photometric_split.json"
            if split_path.exists():
                previous = json.loads(split_path.read_text(encoding="utf-8"))
                if previous != specification:
                    raise ValueError("Persisted photometric split does not match registered images")
            else:
                _write_json(split_path, specification)
            self.indices = np.array(
                [
                    index
                    for index, name in enumerate(parser.image_names)
                    if specification["image_to_source_id"][name]
                    in specification["train_source_ids" if split == "train" else "validation_source_ids"]
                ],
                dtype=np.int64,
            )
            transform = np.asarray(parser.transform, dtype=float)
            if transform.shape != (4, 4) or not np.isfinite(transform).all():
                raise ValueError("Invalid COLMAP to trainer transform")
            inverse = np.linalg.inv(transform)
            _write_json(
                scene / "geometry_frames.json",
                {
                    "colmap_to_trainer": transform.tolist(),
                    "trainer_to_colmap": inverse.tolist(),
                    "artifacts": {"gsplat": "trainer", "dense/fused.ply": "colmap"},
                },
            )

    class SplitRunner(original_runner):
        @torch.no_grad()
        def eval(self, step: int, stage: str = "val") -> None:
            if stage != "val" or self.world_size != 1 or self.world_rank != 0:
                raise ValueError("Photometric evaluation requires single-rank validation")
            scene = Path(self.cfg.data_dir)
            split = json.loads((scene / "photometric_split.json").read_text(encoding="utf-8"))
            train_ids = [split["image_to_source_id"][self.parser.image_names[int(i)]] for i in self.trainset.indices]
            val_names = [self.parser.image_names[int(i)] for i in self.valset.indices]
            expected = split["validation_source_ids"]
            manifest = json.loads((scene / "input_manifest.json").read_text(encoding="utf-8"))
            scoring_sizes = (
                {
                    frame["source_id"]: (frame["height"], frame["width"])
                    for frame in manifest["frames"]
                    if frame["validation"]
                }
                if manifest.get("retain_frozen_sources")
                else {}
            )
            if (
                train_ids != split["train_source_ids"]
                or [split["image_to_source_id"][n] for n in val_names] != expected
            ):
                raise ValueError("Trainer datasets do not match the persisted photometric split")
            if set(train_ids) & set(expected):
                raise ValueError("Photometric train/validation leakage")
            loader = torch.utils.data.DataLoader(self.valset, batch_size=1, shuffle=False, num_workers=1)
            views = []
            for index, data in enumerate(loader):
                item = int(data["image_id"].item())
                if item != index or item >= len(val_names):
                    raise ValueError("Rendered dataset order does not match validation split")
                pixels = data["image"].to(self.device) / 255.0
                mask = data["mask"].to(self.device) if "mask" in data else None
                exposure = data["exposure"].to(self.device) if "exposure" in data else None
                height, width = pixels.shape[1:3]
                colors, _, _ = self.stage.render(
                    self.scene.id,
                    camtoworlds=data["camtoworld"].to(self.device),
                    Ks=data["K"].to(self.device),
                    width=width,
                    height=height,
                    sh_degree=self.cfg.sh_degree,
                    near_plane=self.cfg.near_plane,
                    far_plane=self.cfg.far_plane,
                    masks=mask,
                    frame_idcs=None,
                    camera_idcs=data["camera_idx"].to(self.device),
                    exposure=exposure,
                )
                colors = torch.clamp(colors, 0.0, 1.0)
                canvas = torch.cat([pixels, colors], dim=2).squeeze(0).cpu().numpy()
                imageio.imwrite(
                    f"{self.render_dir}/{stage}_step{step}_{index:04d}.png", (canvas * 255).astype(np.uint8)
                )
                prediction, target = colors.permute(0, 3, 1, 2), pixels.permute(0, 3, 1, 2)
                name = val_names[index]
                source = split["image_to_source_id"][name]
                scoring_size = scoring_sizes.get(source, (height, width))
                if scoring_size != (height, width):
                    prediction, target = torch.nn.functional.interpolate(
                        torch.cat((prediction, target)),
                        size=scoring_size,
                        mode="bilinear",
                        align_corners=False,
                        antialias=True,
                    ).chunk(2)
                values = {
                    name: float(getattr(self, name)(prediction, target).item()) for name in ("psnr", "ssim", "lpips")
                }
                if not all(math.isfinite(value) for value in values.values()):
                    raise ValueError("Non-finite photometric metric")
                if scoring_sizes:
                    values["scoring_height"], values["scoring_width"] = scoring_size
                views.append({"source_id": source, "image_name": name, **values})
            actual = [view["source_id"] for view in views]
            if actual != expected or set(actual) & set(train_ids):
                raise ValueError("Rendered views do not match validation split")
            _write_json(
                Path(self.cfg.result_dir) / "photometric_views.json",
                {
                    "schema_version": 1,
                    "step": step,
                    "split": stage,
                    "train_source_ids": train_ids,
                    "validation_source_ids": actual,
                    "views": views,
                },
            )
            stats = {name: sum(view[name] for view in views) / len(views) for name in ("psnr", "ssim", "lpips")}
            stats["num_GS"] = len(self.splats["means"])
            _write_json(Path(self.stats_dir) / f"{stage}_step{step:04d}.json", stats)
            for name, value in stats.items():
                self.writer.add_scalar(f"{stage}/{name}", value, step)
            self.writer.flush()
            if step == self.cfg.max_steps - 1:
                _write_json(Path(self.cfg.result_dir) / "run.json", {"ply_step": step, "eval_step": step})

    trainer.Dataset = SplitDataset
    trainer.Runner = SplitRunner


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--split-file", type=Path, required=True)
    parser.add_argument("--init-points", choices=("sparse", "dense"), default="sparse")
    parser.add_argument("--seed", type=int, default=42)
    args, remaining = parser.parse_known_args()
    sys.argv = [sys.argv[0], *remaining]
    root = Path(os.environ.get("RESCENE_ROOT", Path.cwd())).resolve()
    sys.path.insert(0, str(root / "third_party" / "gsplat" / "examples"))
    import simple_trainer as trainer

    seed_upstream = trainer.set_random_seed
    trainer.set_random_seed = lambda seed: seed_upstream(seed + args.seed - 42)

    configure_trainer(trainer, args.split_file, args.init_points)
    configs = {
        "default": ("Gaussian splatting", trainer.Config(strategy=trainer.DefaultStrategy(verbose=True))),
    }
    cfg = trainer.tyro.extras.overridable_config_cli(configs)
    cfg.adjust_steps(cfg.steps_scaler)
    trainer.cli(trainer.main, cfg, verbose=True)


if __name__ == "__main__":
    main()
