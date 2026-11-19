from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from rescene.pipeline import _ensure_downsampled_images
from rescene.preprocess import classify_input, preprocess_input


def _pattern(path: Path, offset: int = 0, size: tuple[int, int] = (32, 24)) -> None:
    pixels = np.random.default_rng(offset).integers(0, 256, (size[1], size[0], 3), dtype="uint8")
    Image.fromarray(pixels).save(path)


def test_input_validation(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="No JPG"):
        classify_input(tmp_path)
    unsupported = tmp_path / "input.txt"
    unsupported.write_text("x")
    with pytest.raises(ValueError, match="supported video"):
        classify_input(unsupported)


def test_preprocess_deduplicates_and_splits_validation(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(10):
        _pattern(source / f"{index:02d}.png", offset=index * 8)
    Image.open(source / "00.png").save(source / "01.png")

    manifest = preprocess_input(source, tmp_path / "scene", scene="unit", max_frames=8, duplicate_distance=0)

    assert manifest["counts"]["selected"] == 8
    assert any(frame["duplicate"] for frame in manifest["frames"])
    selected = [frame for frame in manifest["frames"] if frame["selected"]]
    assert all(frame["validation"] == (frame["index"] % 8 == 0) for frame in selected)
    import json

    split = json.loads((tmp_path / "scene" / "photometric_selection.json").read_text(encoding="utf-8"))
    assert split["validation_source_ids"] == [frame["source_id"] for frame in selected if frame["validation"]]
    assert split["train_source_ids"] == [frame["source_id"] for frame in selected if not frame["validation"]]
    assert len(list((tmp_path / "scene" / "images").glob("*.jpg"))) == 8


def test_exif_orientation_is_applied(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    first = Image.new("RGB", (10, 20), (255, 0, 0))
    exif = first.getexif()
    exif[274] = 6
    first.save(source / "a.jpg", exif=exif)
    _pattern(source / "b.png", offset=99)

    manifest = preprocess_input(source, tmp_path / "scene", scene="exif", max_frames=2, duplicate_distance=0)

    assert (manifest["frames"][0]["width"], manifest["frames"][0]["height"]) == (20, 10)


def test_video_extraction_manifest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"placeholder")

    def fake_run(command: list[str], *, check: bool, **kwargs):
        if kwargs.get("capture_output"):
            from subprocess import CompletedProcess

            return CompletedProcess(command, 1, stderr=b"Duration: 00:00:10.00")
        output = Path(command[-1]).parent
        assert command[command.index("-frames:v") + 1] == "6"
        assert "fps=0.600000000000" in command[command.index("-vf") + 1]
        output.mkdir(parents=True, exist_ok=True)
        _pattern(output / "000001.jpg", 0)
        _pattern(output / "000002.jpg", 100)

    monkeypatch.setattr("rescene.preprocess.subprocess.run", fake_run)
    monkeypatch.setattr("rescene.preprocess.imageio_ffmpeg.get_ffmpeg_exe", lambda: "ffmpeg")
    manifest = preprocess_input(video, tmp_path / "scene", scene="video", max_frames=2, duplicate_distance=0)

    assert manifest["source_type"] == "video"
    assert manifest["counts"]["discovered"] == 2


def test_downsampled_images_for_gsplat_fallback(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _pattern(images / "frame.jpg", size=(40, 20))

    _ensure_downsampled_images(tmp_path, 2)

    with Image.open(tmp_path / "images_2" / "frame.jpg") as image:
        assert image.size == (20, 10)


def test_global_duplicates_and_coverage_selection_are_deterministic(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(6):
        _pattern(source / f"{index}.png", offset=index + 10)
    Image.open(source / "0.png").save(source / "4.png")

    first = preprocess_input(source, tmp_path / "first", scene="first", max_frames=4, duplicate_distance=0)
    second = preprocess_input(source, tmp_path / "second", scene="second", max_frames=4, duplicate_distance=0)

    assert first["frames"][4]["duplicate"]
    assert first["schema_version"] == 2
    assert [frame["index"] for frame in first["frames"] if frame["selected"]] == [
        frame["index"] for frame in second["frames"] if frame["selected"]
    ]


def test_severely_exposed_frame_is_marked_and_skipped(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(4):
        _pattern(source / f"{index}.png", offset=index + 20)
    Image.new("RGB", (32, 24), "white").save(source / "2.png")

    manifest = preprocess_input(source, tmp_path / "scene", scene="quality", max_frames=3, duplicate_distance=0)

    exposed = manifest["frames"][2]
    assert exposed["quality_rejected"]
    assert not exposed["selected"]
    assert exposed["selection_reason"] == "quality_rejected"


def test_record_hashes_adds_input_digest(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(4):
        _pattern(source / f"{index}.png", offset=index + 30)

    manifest = preprocess_input(
        source, tmp_path / "scene", scene="hashes", max_frames=4, duplicate_distance=0, record_hashes=True
    )

    assert manifest["settings"]["record_hashes"] is True
    assert manifest["settings"]["seed"] == 42
    assert len(manifest["input_sha256"]) == 64
    for frame in manifest["frames"]:
        assert len(frame["source_sha256"]) == 64
        assert len(frame["normalized_sha256"]) == 64

    repeat = preprocess_input(
        source, tmp_path / "repeat", scene="hashes", max_frames=4, duplicate_distance=0, record_hashes=True
    )
    assert repeat["input_sha256"] == manifest["input_sha256"]


def test_input_digest_is_absent_without_hashes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _pattern(source / "a.png", offset=1)
    _pattern(source / "b.png", offset=2)

    manifest = preprocess_input(source, tmp_path / "scene", scene="plain", max_frames=2, duplicate_distance=0)

    assert manifest["input_sha256"] is None
    assert manifest["settings"]["record_hashes"] is False
    assert manifest["frames"][0]["source_sha256"] is None
    assert manifest["frames"][0]["normalized_sha256"] is None


def test_frozen_validation_sources_replace_position_rule(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(10):
        _pattern(source / f"{index:02d}.png", offset=index + 40)
    frozen = {str((source / "00.png").resolve()), str((source / "05.png").resolve())}

    manifest = preprocess_input(
        source,
        tmp_path / "scene",
        scene="frozen",
        max_frames=10,
        duplicate_distance=0,
        validation_sources=frozen,
    )

    selected = [frame for frame in manifest["frames"] if frame["selected"]]
    assert [frame["validation"] for frame in selected].count(True) == 2
    assert {frame["source"] for frame in selected if frame["validation"]} == frozen


def test_frozen_validation_must_leave_training_frames(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(4):
        _pattern(source / f"{index}.png", offset=index + 70)
    with pytest.raises(ValueError, match="leave room for at least one training frame"):
        preprocess_input(
            source,
            tmp_path / "output",
            scene="scene",
            max_frames=2,
            duplicate_distance=0,
            validation_sources={"0.png", "1.png", "2.png", "3.png"},
        )


@pytest.mark.parametrize("budget", [4, 6, 10])
def test_frozen_validation_is_identical_across_frame_budgets(tmp_path: Path, budget: int) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(40):
        _pattern(source / f"{index:02d}.png", offset=index + 20)
    frozen = {str((source / "01.png").resolve()), str((source / "17.png").resolve())}
    manifest = preprocess_input(
        source,
        tmp_path / f"scene-{budget}",
        scene="budget",
        max_frames=budget,
        duplicate_distance=0,
        validation_sources=frozen,
    )
    selected = [frame for frame in manifest["frames"] if frame["selected"]]
    assert len(selected) == budget
    assert {frame["source"] for frame in selected if frame["validation"]} == frozen


def test_source_ids_are_scene_relative_and_canonical(tmp_path: Path) -> None:
    from rescene.preprocess import source_id

    scene = tmp_path / "scene"
    scene.mkdir()
    target = scene / "frame.jpg"
    target.touch()
    assert source_id(scene, target) == "frame.jpg"
    alias = scene / "alias.jpg"
    try:
        alias.symlink_to(target)
    except OSError:
        pytest.skip("Symlinks are unavailable")
    assert source_id(scene, alias) == "frame.jpg"
    outside = tmp_path / "outside.jpg"
    outside.touch()
    external = scene / "external.jpg"
    external.symlink_to(outside)
    with pytest.raises(ValueError, match="outside scene root"):
        source_id(scene, external)


def test_freeze_records_scene_relative_ids(tmp_path: Path) -> None:
    import json

    from scripts.freeze_validation_frames import freeze

    scene = tmp_path / "scene"
    scene.mkdir()
    for index in range(3):
        _pattern(scene / f"{index}.png", offset=index)
    manifest = tmp_path / "dataset.json"
    manifest.write_text(json.dumps({"scenes": [{"id": "scene", "input": str(scene)}]}), encoding="utf-8")
    result = freeze([manifest], tmp_path / "frozen.json", every=2)
    assert [frame["source_id"] for frame in result["scenes"]["scene"]["frames"]] == ["0.png", "2.png"]


def test_registered_photometric_split_rejects_mismatches() -> None:
    from rescene.gsplat_runner import registered_split

    manifest = {
        "frames": [
            {"selected": True, "validation": False, "file": "images/000000.jpg", "source_id": "a.jpg"},
            {"selected": True, "validation": True, "file": "images/000001.jpg", "source_id": "b.jpg"},
        ]
    }
    split = registered_split(manifest, ["000000.jpg", "000001.jpg"], Path("."))
    assert split["train_source_ids"] == ["a.jpg"]
    assert split["validation_source_ids"] == ["b.jpg"]
    with pytest.raises(ValueError, match="absent"):
        registered_split(manifest, ["unknown.jpg"], Path("."))
    manifest["frames"][1]["source_id"] = "a.jpg"
    with pytest.raises(ValueError, match="Duplicate source IDs"):
        registered_split(manifest, ["000000.jpg", "000001.jpg"], Path("."))


def test_worker_split_accepts_documented_missing_views_without_leakage(tmp_path: Path) -> None:
    from rescene.gsplat_runner import registered_split

    manifest = {
        "frames": [
            {"selected": True, "validation": i > 0, "file": str(tmp_path / "images" / f"{i}.jpg"), "source_id": str(i)}
            for i in range(5)
        ]
    }
    registered = ["0.jpg", "1.jpg", "4.jpg"]
    with pytest.raises(ValueError, match="missing"):
        registered_split(manifest, registered, tmp_path)
    (tmp_path / "benchmark.json").write_text('{"source": "worker"}', encoding="utf-8")
    split = registered_split(manifest, registered, tmp_path)
    assert split["train_source_ids"] == ["0"]
    assert split["validation_source_ids"] == ["1", "4"]
    assert split["missing_validation_source_ids"] == ["2", "3"]
    with pytest.raises(ValueError, match="missing"):
        registered_split(manifest, registered[:2], tmp_path)


def test_frozen_validation_survives_duplicate_filtering(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(10):
        _pattern(source / f"{index:02d}.png", offset=index + 30)
    _pattern(source / "07.png", offset=2 + 30)
    frozen = {str((source / "07.png").resolve())}
    manifest = preprocess_input(
        source,
        tmp_path / "scene",
        scene="duplicate",
        max_frames=6,
        duplicate_distance=16,
        validation_sources=frozen,
    )
    captured = [frame for frame in manifest["frames"] if frame["source"] in frozen]
    assert len(captured) == 1
    assert captured[0]["selected"] is True and captured[0]["validation"] is True
    assert captured[0]["duplicate"] is True
    assert sum(frame["selected"] for frame in manifest["frames"]) == 6
