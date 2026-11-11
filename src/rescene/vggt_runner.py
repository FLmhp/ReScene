"""Run the pinned VGGT COLMAP demo with an offline checkpoint."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace


def _load_checkpoint(path: Path) -> dict[str, object]:
    if not path.exists() and path.name == "model.safetensors":
        path = path.with_name("model.pt")
    if not path.exists():
        raise FileNotFoundError(f"VGGT checkpoint not found: {path}")
    if path.suffix == ".safetensors":
        from safetensors.torch import load_file

        return load_file(str(path), device="cpu")
    import torch

    loaded = torch.load(path, map_location="cpu", weights_only=True)
    return loaded.get("model", loaded) if isinstance(loaded, dict) else loaded


def _offline_loader(vggt_state: dict[str, object], tracker_checkpoint: Path, dinov2_checkpoint: Path):
    def load(url: str, *_args: object, **_kwargs: object) -> dict[str, object]:
        name = Path(url).name
        if name == "vggsfm_v2_tracker.pt":
            return _load_checkpoint(tracker_checkpoint)
        if name == "dinov2_vitb14_reg4_pretrain.pth":
            return _load_checkpoint(dinov2_checkpoint)
        if name in {"model.pt", "model.safetensors"}:
            return vggt_state
        raise RuntimeError(f"Unexpected offline checkpoint request: {url}")

    return load


def _offline_hub_loader(loader, dinov2_dir: Path):
    def load(repo_or_dir: str, model: str, *args, **kwargs):
        if repo_or_dir != "facebookresearch/dinov2":
            raise RuntimeError(f"Unexpected offline Torch Hub repository: {repo_or_dir}")
        return loader(str(dinov2_dir), model, *args, source="local", **kwargs)

    return load


def _skip_dino_when_all_frames(rank):
    def select(images, query_frame_num: int, *args, **kwargs):
        if query_frame_num >= len(images):
            return list(range(len(images)))
        return rank(images, query_frame_num, *args, **kwargs)

    return select


def _offline_sift_extractors(initializer):
    def initialize(max_query_num, det_thres=0.005, extractor_method="aliked", device="cuda"):
        return initializer(max_query_num, det_thres, "sift", device)

    return initialize


# demo_colmap at this revision loads padding coordinates at 1024 but uses
# 518-pixel observations in its non-BA branch. Keep this adapter tied to the
# source whose coordinate contract it corrects.
_VGGT_REVISION = "a288dd0f14786c93483e45524328726ab7b1b4ce"
_VGGT_LOAD_RESOLUTION = 1024
_ADAPTER_PATCH = "scale-padding-coordinates-to-reconstruction-resolution-v1"


def _correct_padding_coordinates(rename):
    def corrected(reconstruction, image_paths, original_coords, img_size, **kwargs):
        # original_coords[:4] describes the padded image in 1024-pixel space;
        # its last two columns are the original image dimensions. Upstream
        # subtracts the top-left padding before multiplying by max(size)/img_size.
        # Scale the padding into the observation space first, leaving dimensions
        # untouched. In BA img_size is 1024 and the transform is already correct.
        if img_size != _VGGT_LOAD_RESOLUTION:
            original_coords = original_coords.copy()
            original_coords[:, :4] *= img_size / _VGGT_LOAD_RESOLUTION
        return rename(reconstruction, image_paths, original_coords, img_size, **kwargs)

    return corrected


def _write_adapter_provenance(vendor_dir: Path, scene_dir: Path) -> None:
    revision = (vendor_dir / ".revision").read_text(encoding="utf-8").strip()
    if revision != _VGGT_REVISION:
        raise RuntimeError(f"Unsupported VGGT revision {revision!r}; expected {_VGGT_REVISION}")
    scene_dir.mkdir(parents=True, exist_ok=True)
    (scene_dir / "vggt-adapter.json").write_text(
        json.dumps({"vendor_revision": revision, "adapter_patch": _ADAPTER_PATCH}, indent=2) + "\n",
        encoding="utf-8",
    )


def _capture_pre_bundle_adjustment(pycolmap, destination: Path):
    """Snapshot the reconstruction before upstream bundle adjustment mutates it."""
    original = pycolmap.bundle_adjustment

    def bundle_adjustment(reconstruction, *args, **kwargs):
        shutil.rmtree(destination, ignore_errors=True)
        destination.mkdir(parents=True, exist_ok=True)
        reconstruction.write(destination)
        return original(reconstruction, *args, **kwargs)

    return original, bundle_adjustment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor-dir", type=Path, required=True)
    parser.add_argument("--pycolmap-dir", type=Path, required=True)
    parser.add_argument("--scene-dir", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--tracker-checkpoint", type=Path, required=True)
    parser.add_argument("--dinov2-dir", type=Path, required=True)
    parser.add_argument("--dinov2-checkpoint", type=Path, required=True)
    parser.add_argument("--use-ba", action="store_true")
    parser.add_argument("--fine-tracking", action="store_true")
    parser.add_argument("--query-frames", type=int, default=8)
    parser.add_argument("--max-query-points", type=int, default=2_048)
    parser.add_argument("--max-reprojection-error", type=float, default=8.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--diagnostics", action="store_true")
    args = parser.parse_args()

    sys.path[:0] = [str(args.pycolmap_dir), str(args.vendor_dir)]
    import demo_colmap
    import pycolmap
    import torch
    from vggt.dependency import track_predict

    _write_adapter_provenance(args.vendor_dir, args.scene_dir)
    torch.manual_seed(args.seed)
    pre_ba_dir = args.scene_dir / "sparse-pre-ba"
    original_bundle_adjustment = None
    if args.use_ba:
        original_bundle_adjustment, patched = _capture_pre_bundle_adjustment(pycolmap, pre_ba_dir)
        pycolmap.bundle_adjustment = patched

    state_dict = _load_checkpoint(args.checkpoint)
    original_loader = torch.hub.load_state_dict_from_url
    original_hub_loader = torch.hub.load
    original_rank = track_predict.generate_rank_by_dino
    original_extractors = track_predict.initialize_feature_extractors
    torch.hub.load_state_dict_from_url = _offline_loader(state_dict, args.tracker_checkpoint, args.dinov2_checkpoint)
    torch.hub.load = _offline_hub_loader(original_hub_loader, args.dinov2_dir)
    track_predict.generate_rank_by_dino = _skip_dino_when_all_frames(original_rank)
    track_predict.initialize_feature_extractors = _offline_sift_extractors(original_extractors)
    options = SimpleNamespace(
        scene_dir=str(args.scene_dir),
        seed=args.seed,
        use_ba=args.use_ba,
        max_reproj_error=args.max_reprojection_error,
        shared_camera=False,
        camera_type="SIMPLE_PINHOLE",
        vis_thresh=0.2,
        query_frame_num=args.query_frames,
        max_query_pts=args.max_query_points,
        fine_tracking=args.fine_tracking,
        conf_thres_value=5.0,
    )
    original_rename = demo_colmap.rename_colmap_recons_and_rescale_camera
    demo_colmap.rename_colmap_recons_and_rescale_camera = _correct_padding_coordinates(original_rename)
    try:
        with torch.inference_mode():
            demo_colmap.demo_fn(options)
    finally:
        demo_colmap.rename_colmap_recons_and_rescale_camera = original_rename
        torch.hub.load_state_dict_from_url = original_loader
        torch.hub.load = original_hub_loader
        track_predict.generate_rank_by_dino = original_rank
        track_predict.initialize_feature_extractors = original_extractors
        if original_bundle_adjustment is not None:
            pycolmap.bundle_adjustment = original_bundle_adjustment
    if args.diagnostics and args.use_ba and pre_ba_dir.is_dir():
        from rescene.geometry_metrics import compare_bundle_adjustment

        compare_bundle_adjustment(pre_ba_dir, args.scene_dir / "sparse", args.scene_dir / "geometry-ba.json")


if __name__ == "__main__":
    main()
