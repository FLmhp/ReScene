"""Non-destructive image and video preprocessing."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageOps

from rescene.metrics import sha256_file

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
VIDEO_DEMUXERS = {".mp4": "mov", ".mov": "mov", ".m4v": "mov", ".mkv": "matroska", ".webm": "matroska", ".avi": "avi"}


@dataclass(frozen=True)
class FrameInfo:
    """Quality and selection information for one normalized frame."""

    index: int
    source: str
    source_id: str
    file: str
    width: int
    height: int
    blur_score: float
    underexposed_ratio: float
    overexposed_ratio: float
    dhash: int
    duplicate: bool
    quality_rejected: bool
    selected: bool
    validation: bool
    selection_reason: str
    source_sha256: str | None = None
    normalized_sha256: str | None = None


def discover_images(input_path: Path) -> list[Path]:
    """Return supported images in deterministic order."""
    if not input_path.is_dir():
        raise ValueError(f"Image input must be a directory: {input_path}")
    images = sorted(path for path in input_path.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
    if not images:
        raise ValueError(f"No JPG, JPEG, or PNG images found in {input_path}")
    return images


def source_id(scene_root: Path, source: Path) -> str:
    """Identify a source by its canonical path relative to the scene root."""
    root = scene_root.resolve()
    candidate = source if source.is_absolute() else root / source
    try:
        return candidate.resolve().relative_to(root).as_posix()
    except ValueError as error:
        raise ValueError(f"Image resolves outside scene root: {source}") from error


def classify_input(input_path: Path) -> str:
    """Classify an existing input as an image directory or supported video."""
    if input_path.is_dir():
        discover_images(input_path)
        return "images"
    if input_path.is_file() and input_path.suffix.lower() in VIDEO_SUFFIXES:
        return "video"
    raise ValueError(f"Input must be an image directory or a supported video: {input_path}")


def video_input_args(video: Path) -> list[str]:
    """Restrict uploaded videos to the expected local container demuxer."""
    return ["-protocol_whitelist", "file,pipe", "-f", VIDEO_DEMUXERS[video.suffix.lower()], "-i", str(video)]


def _extract_video(video: Path, output_dir: Path, fps: float, frame_budget: int, max_side: int) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    probe = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", *video_input_args(video)],
        capture_output=True,
        timeout=20,
        check=False,
    )
    match = re.search(rb"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
    if match:
        hours, minutes, seconds = map(float, match.groups())
        duration = hours * 3600 + minutes * 60 + seconds
        if duration > 0:
            fps = min(fps, frame_budget / duration)
    command = [
        ffmpeg,
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        *video_input_args(video),
        "-map",
        "0:v:0",
        "-frames:v",
        str(frame_budget),
        "-vf",
        f"fps={fps:.12f},scale='min(iw,{max_side})':'min(ih,{max_side})':force_original_aspect_ratio=decrease",
        "-q:v",
        "2",
        str(output_dir / "%06d.jpg"),
    ]
    subprocess.run(command, check=True, timeout=600)
    return discover_images(output_dir)


def _laplacian_variance(gray: np.ndarray) -> float:
    center = -4.0 * gray[1:-1, 1:-1]
    laplacian = center + gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
    return float(laplacian.var())


def _dhash(gray_image: Image.Image) -> int:
    pixels = np.asarray(gray_image.resize((9, 8), Image.Resampling.LANCZOS), dtype=np.uint8)
    bits = pixels[:, 1:] > pixels[:, :-1]
    value = 0
    for bit in bits.ravel():
        value = (value << 1) | int(bit)
    return value


def _hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def _normalize_image(source: Path, destination: Path, max_side: int) -> tuple[int, int, float, float, float, int]:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        if max(image.size) > max_side:
            image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, format="JPEG", quality=95, subsampling=0)
        gray_image = image.convert("L")
        gray = np.asarray(gray_image, dtype=np.float32)
        return (
            image.width,
            image.height,
            _laplacian_variance(gray),
            float(np.mean(gray <= 8)),
            float(np.mean(gray >= 247)),
            _dhash(gray_image),
        )


def _coverage_descriptor(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        pixels = np.asarray(image.convert("L").resize((16, 12), Image.Resampling.BILINEAR), dtype=np.float32)
    pixels -= pixels.mean()
    norm = float(np.linalg.norm(pixels))
    return (pixels / norm).ravel() if norm else pixels.ravel()


def _coverage_limit(records: list[dict[str, object]], candidates: list[int], limit: int) -> set[int]:
    if len(candidates) < 2:
        raise ValueError("At least two non-duplicate frames are required")
    if limit < 2:
        raise ValueError("max_frames must be at least 2")
    if len(candidates) <= limit:
        return set(candidates)
    descriptors = {index: _coverage_descriptor(Path(str(records[index]["normalized"]))) for index in candidates}
    selected = [candidates[0], candidates[-1]]
    blur_values = np.log1p([float(records[index]["blur_score"]) for index in candidates])
    blur_scale = float(blur_values.max()) or 1.0
    positions = {index: position / (len(candidates) - 1) for position, index in enumerate(candidates)}
    while len(selected) < limit:
        best = max(
            (index for index in candidates if index not in selected),
            key=lambda index: (
                0.7 * min(float(np.linalg.norm(descriptors[index] - descriptors[chosen])) for chosen in selected) / 2.0
                + 0.2 * min(abs(positions[index] - positions[chosen]) for chosen in selected)
                + 0.1 * float(np.log1p(float(records[index]["blur_score"]))) / blur_scale,
                -index,
            ),
        )
        selected.append(best)
    return set(selected)


def preprocess_input(
    input_path: Path,
    output_dir: Path,
    *,
    scene: str,
    max_frames: int,
    max_side: int = 1600,
    video_fps: float = 2.0,
    duplicate_distance: int = 4,
    record_hashes: bool = False,
    validation_sources: set[str] | None = None,
    seed: int = 42,
) -> dict[str, object]:
    """Normalize, score, de-duplicate, and select frames without changing the source."""
    input_path = input_path.resolve()
    source_type = classify_input(input_path)
    raw_dir = output_dir / "video_frames"
    if source_type == "images":
        sources = discover_images(input_path)
    else:
        # An OOM retry can extract a smaller candidate set into the same run.
        if raw_dir.exists():
            shutil.rmtree(raw_dir)
        sources = _extract_video(input_path, raw_dir, video_fps, max_frames * 3, max_side)

    source_root = input_path if source_type == "images" else raw_dir.resolve()
    source_ids = [source_id(source_root, source.resolve()) for source in sources]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError("Multiple input images resolve to the same source ID")
    frozen_validation = (
        {source_id(source_root, Path(path)) for path in validation_sources} if validation_sources is not None else None
    )
    if frozen_validation is not None and not frozen_validation.issubset(source_ids):
        raise ValueError("Frozen validation contains unknown source IDs")

    normalized_dir = output_dir / "normalized"
    records: list[dict[str, object]] = []
    unique_hashes: list[int] = []
    unique_indexes: list[int] = []
    for index, source in enumerate(sources):
        destination = normalized_dir / f"{index:06d}.jpg"
        width, height, blur, underexposed, overexposed, dhash = _normalize_image(source, destination, max_side)
        duplicate = any(_hamming_distance(previous, dhash) <= duplicate_distance for previous in unique_hashes)
        if not duplicate:
            unique_hashes.append(dhash)
            unique_indexes.append(index)
        quality_rejected = blur < 2.0 or underexposed > 0.95 or overexposed > 0.95
        record: dict[str, object] = {
            "index": index,
            "source": str(source),
            "source_id": source_ids[index],
            "normalized": str(destination),
            "width": width,
            "height": height,
            "blur_score": round(blur, 4),
            "underexposed_ratio": round(underexposed, 6),
            "overexposed_ratio": round(overexposed, 6),
            "dhash": dhash,
            "duplicate": duplicate,
            "quality_rejected": quality_rejected,
        }
        if record_hashes:
            record["source_sha256"] = sha256_file(source)
            record["source_bytes"] = source.stat().st_size
            record["normalized_sha256"] = sha256_file(destination)
        records.append(record)

    eligible_indexes = [index for index in unique_indexes if not bool(records[index]["quality_rejected"])]
    if len(eligible_indexes) < min(2, len(unique_indexes)):
        eligible_indexes = unique_indexes
    budget = min(max_frames, len(eligible_indexes))
    if frozen_validation is not None and len(frozen_validation) >= budget:
        raise ValueError("Frozen validation must leave room for at least one training frame")
    forced_indexes: set[int] = set()
    if frozen_validation is not None:
        forced_indexes = {
            index for index in range(len(records)) if str(records[index]["source_id"]) in frozen_validation
        }
        if {str(records[index]["source_id"]) for index in forced_indexes} != frozen_validation:
            raise ValueError("Frozen validation contains a duplicate or unknown source")
        remaining = [index for index in eligible_indexes if index not in forced_indexes]
        limit = min(budget - len(forced_indexes), len(remaining))
        if limit <= 0:
            extra: set[int] = set()
        elif len(remaining) <= limit:
            extra = set(remaining)
        elif limit == 1:
            extra = {remaining[0]}
        else:
            extra = _coverage_limit(records, remaining, limit)
        selected_indexes = forced_indexes | extra
    else:
        selected_indexes = _coverage_limit(records, eligible_indexes, budget)
    if len(selected_indexes) < 2:
        raise ValueError("At least two non-duplicate frames are required")
    if frozen_validation is not None:
        selected_ids = {str(records[index]["source_id"]) for index in selected_indexes}
        missing = frozen_validation - selected_ids
        if missing:
            raise ValueError(f"Frozen validation sources were not selected: {sorted(missing)}")
    images_dir = output_dir / "images"
    if images_dir.exists():
        shutil.rmtree(images_dir)
    images_dir.mkdir(parents=True)
    selected_records: list[FrameInfo] = []
    selected_position = 0
    for record in records:
        selected = int(record["index"]) in selected_indexes
        if frozen_validation is None:
            validation = selected and int(record["index"]) % 8 == 0
        else:
            validation = selected and str(record["source_id"]) in frozen_validation
        if selected:
            output_file = images_dir / f"{selected_position:06d}.jpg"
            shutil.copy2(str(record["normalized"]), output_file)
            selected_position += 1
        else:
            output_file = Path(str(record["normalized"]))
        selected_records.append(
            FrameInfo(
                index=int(record["index"]),
                source=str(record["source"]),
                source_id=str(record["source_id"]),
                file=str(output_file),
                width=int(record["width"]),
                height=int(record["height"]),
                blur_score=float(record["blur_score"]),
                underexposed_ratio=float(record["underexposed_ratio"]),
                overexposed_ratio=float(record["overexposed_ratio"]),
                dhash=int(record["dhash"]),
                duplicate=bool(record["duplicate"]),
                quality_rejected=bool(record["quality_rejected"]),
                selected=selected,
                validation=validation,
                selection_reason=(
                    "coverage"
                    if selected
                    else "duplicate"
                    if record["duplicate"]
                    else "quality_rejected"
                    if record["quality_rejected"]
                    else "frame_limit"
                ),
                source_sha256=record.get("source_sha256"),  # type: ignore[arg-type]
                normalized_sha256=record.get("normalized_sha256"),  # type: ignore[arg-type]
            )
        )

    input_sha256: str | None = None
    if record_hashes:
        if source_type == "video":
            input_sha256 = sha256_file(input_path)
        else:
            combined = hashlib.sha256()
            entries = sorted(
                (
                    Path(str(record["source"])).name,
                    int(record["source_bytes"]),
                    str(record["source_sha256"]),
                )
                for record in records
            )
            for name, size, digest in entries:
                combined.update(f"{name}\0{size}\0{digest}\n".encode())
            input_sha256 = combined.hexdigest()

    manifest: dict[str, object] = {
        "schema_version": 2,
        "scene": scene,
        "source": str(input_path),
        "source_type": source_type,
        "input_sha256": input_sha256,
        "settings": {
            "max_frames": max_frames,
            "max_side": max_side,
            "video_fps": video_fps,
            "duplicate_distance": duplicate_distance,
            "validation_every": 8,
            "record_hashes": record_hashes,
            "seed": seed,
        },
        "counts": {
            "discovered": len(sources),
            "unique": len(unique_indexes),
            "eligible": len(eligible_indexes),
            "selected": len(selected_indexes),
        },
        "frames": [asdict(record) for record in selected_records],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "input_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    split = {
        "schema_version": 1,
        "train_source_ids": [frame.source_id for frame in selected_records if frame.selected and not frame.validation],
        "validation_source_ids": [frame.source_id for frame in selected_records if frame.selected and frame.validation],
        "image_to_source_id": {
            Path(frame.file).relative_to(images_dir).as_posix(): frame.source_id
            for frame in selected_records
            if frame.selected
        },
    }
    (output_dir / "photometric_selection.json").write_text(
        json.dumps(split, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def relocate_selected_images(run_dir: Path) -> None:
    """Rebase selected image paths after moving a reconstruction directory."""
    manifest_path = run_dir / "input_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for frame in manifest["frames"]:
        if frame.get("selected"):
            image = run_dir / "images" / Path(frame["file"]).name
            if not image.is_file():
                raise FileNotFoundError(f"Selected image missing: {image.name}")
            frame["file"] = str(image)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def selected_files(manifest: dict[str, object]) -> Iterable[Path]:
    """Yield selected frame files from a manifest."""
    for frame in manifest["frames"]:  # type: ignore[index]
        if frame["selected"]:  # type: ignore[index]
            yield Path(frame["file"])  # type: ignore[index]
