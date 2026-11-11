import json
from pathlib import Path

import numpy as np
import pytest

from rescene import vggt_runner


def test_offline_loader_dispatches_pinned_weights(monkeypatch):
    monkeypatch.setattr(vggt_runner, "_load_checkpoint", lambda path: {"tracker": path.name})
    loader = vggt_runner._offline_loader({"weight": "vggt"}, Path("tracker.pt"), Path("dinov2.pth"))
    assert loader("https://example.test/model.pt") == {"weight": "vggt"}
    assert loader("https://example.test/vggsfm_v2_tracker.pt") == {"tracker": "tracker.pt"}
    assert loader("https://example.test/dinov2_vitb14_reg4_pretrain.pth") == {"tracker": "dinov2.pth"}
    with pytest.raises(RuntimeError, match="Unexpected offline checkpoint"):
        loader("https://example.test/unknown.pt")


def test_offline_hub_loader_only_dispatches_dinov2(tmp_path):
    calls = []

    def original(*args, **kwargs):
        calls.append((args, kwargs))
        return "model"

    loader = vggt_runner._offline_hub_loader(original, tmp_path)
    assert loader("facebookresearch/dinov2", "dinov2_vitb14_reg") == "model"
    assert calls == [((str(tmp_path), "dinov2_vitb14_reg"), {"source": "local"})]
    with pytest.raises(RuntimeError, match="Unexpected offline Torch Hub repository"):
        loader("other/repository", "model")


def test_dino_is_skipped_when_every_frame_is_selected():
    rank = vggt_runner._skip_dino_when_all_frames(lambda *_args, **_kwargs: [2, 0])
    assert rank([1, 2, 3], 3) == [0, 1, 2]
    assert rank([1, 2, 3], 2) == [2, 0]


def test_ba_feature_extraction_is_offline_sift():
    calls = []
    initialize = vggt_runner._offline_sift_extractors(lambda *args: calls.append(args) or {"sift": object()})
    assert "sift" in initialize(128, device="cuda")
    assert calls == [(128, 0.005, "sift", "cuda")]


@pytest.mark.parametrize("size", [(1600, 900), (900, 1600), (1001, 700), (1000, 1000)])
@pytest.mark.parametrize("resolution", [518, 1024])
def test_padding_is_converted_to_observation_space(size, resolution):
    width, height = size
    maximum = max(size)
    left, top = (maximum - width) // 2, (maximum - height) // 2
    load_scale = 1024 / maximum
    coords = np.array(
        [[left * load_scale, top * load_scale, (left + width) * load_scale, (top + height) * load_scale, width, height]]
    )
    original_coords = coords.copy()
    original_point = np.array([width * 0.3, height * 0.7])
    observation = (original_point + [left, top]) * resolution / maximum

    def upstream_rename(reconstruction, image_paths, original_coords, img_size, **kwargs):
        assert reconstruction == "reconstruction"
        assert image_paths == ["frame.png"]
        assert kwargs == {"shift_point2d_to_original_res": True, "shared_camera": False}
        assert original_coords[0, -2:].tolist() == [width, height]
        return (observation - original_coords[0, :2]) * maximum / img_size

    corrected = vggt_runner._correct_padding_coordinates(upstream_rename)
    result = corrected(
        "reconstruction", ["frame.png"], coords, resolution, shift_point2d_to_original_res=True, shared_camera=False
    )
    np.testing.assert_allclose(result, original_point, atol=1e-10)
    np.testing.assert_array_equal(coords, original_coords)


def test_adapter_provenance_pins_revision_and_patch(tmp_path):
    vendor = tmp_path / "vendor"
    vendor.mkdir()
    revision_file = vendor / ".revision"
    revision_file.write_text(vggt_runner._VGGT_REVISION + "\n", encoding="utf-8")
    scene = tmp_path / "scene"
    vggt_runner._write_adapter_provenance(vendor, scene)
    provenance = json.loads((scene / "vggt-adapter.json").read_text(encoding="utf-8"))
    assert provenance == {
        "vendor_revision": vggt_runner._VGGT_REVISION,
        "adapter_patch": "scale-padding-coordinates-to-reconstruction-resolution-v1",
    }
    revision_file.write_text("another-revision\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Unsupported VGGT revision"):
        vggt_runner._write_adapter_provenance(vendor, scene)
