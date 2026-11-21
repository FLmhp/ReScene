import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rescene.gsplat_runner import configure_trainer


def test_worker_override_only_changes_training_loader(tmp_path: Path) -> None:
    torch = pytest.importorskip("torch")
    pytest.importorskip("imageio.v2")
    original = torch.utils.data.DataLoader

    class Runner:
        trainset = [1, 2]
        valset = [3]

        def train(self):
            return (
                torch.utils.data.DataLoader(self.trainset, num_workers=4).num_workers,
                torch.utils.data.DataLoader(self.valset, num_workers=1).num_workers,
            )

    trainer = SimpleNamespace(Dataset=torch.utils.data.Dataset, Runner=Runner)
    configure_trainer(trainer, tmp_path / "selection.json", train_workers=8)
    assert trainer.Runner().train() == (8, 1)
    assert torch.utils.data.DataLoader is original


def _setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    torch = pytest.importorskip("torch")
    imageio = pytest.importorskip("imageio.v2")
    images = tmp_path / "images"
    images.mkdir()
    frames = [
        {"file": str(images / "000000.jpg"), "source_id": "a.jpg", "selected": True, "validation": False},
        {"file": str(images / "000001.jpg"), "source_id": "b.jpg", "selected": True, "validation": True},
        {"file": str(images / "000002.jpg"), "source_id": "c.jpg", "selected": True, "validation": False},
    ]
    (tmp_path / "input_manifest.json").write_text(json.dumps({"frames": frames}), encoding="utf-8")
    selection = {
        "schema_version": 1,
        "train_source_ids": ["a.jpg", "c.jpg"],
        "validation_source_ids": ["b.jpg"],
        "image_to_source_id": {"000000.jpg": "a.jpg", "000001.jpg": "b.jpg", "000002.jpg": "c.jpg"},
    }
    selection_path = tmp_path / "photometric_selection.json"
    selection_path.write_text(json.dumps(selection), encoding="utf-8")

    class Dataset:
        def __init__(self, parser, split="train", **kwargs):
            self.parser = parser
            self.split = split

    class Runner:
        pass

    trainer = SimpleNamespace(Dataset=Dataset, Runner=Runner)
    configure_trainer(trainer, selection_path)
    transform = np.array([[2, 0, 0, 4], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]], dtype=float)
    parser = SimpleNamespace(
        data_dir=str(tmp_path),
        image_names=["000000.jpg", "000001.jpg", "000002.jpg"],
        transform=transform,
    )
    monkeypatch.setattr(imageio, "imwrite", lambda *args: None)
    return trainer, parser, selection, selection_path, torch


def test_adapter_uses_persisted_source_split_and_captures_transform(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    trainer, parser, _, _, _ = _setup(tmp_path, monkeypatch)
    train = trainer.Dataset(parser, split="train")
    val = trainer.Dataset(parser, split="val")
    assert train.indices.tolist() == [0, 2]
    assert val.indices.tolist() == [1]
    split = json.loads((tmp_path / "photometric_split.json").read_text(encoding="utf-8"))
    assert split["train_source_ids"] == ["a.jpg", "c.jpg"]
    assert split["validation_source_ids"] == ["b.jpg"]
    geometry = json.loads((tmp_path / "geometry_frames.json").read_text(encoding="utf-8"))
    np.testing.assert_allclose(geometry["colmap_to_trainer"], parser.transform)
    np.testing.assert_allclose(np.asarray(geometry["trainer_to_colmap"]) @ parser.transform, np.eye(4))
    assert geometry["artifacts"]["gsplat"] == "trainer"


def test_adapter_rejects_leakage_and_missing_registered_validation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    trainer, parser, selection, selection_path, _ = _setup(tmp_path, monkeypatch)
    selection["train_source_ids"].append("b.jpg")
    selection_path.write_text(json.dumps(selection), encoding="utf-8")
    with pytest.raises(ValueError, match="selection"):
        trainer.Dataset(parser, split="train")
    selection["train_source_ids"].pop()
    selection_path.write_text(json.dumps(selection), encoding="utf-8")
    parser.image_names = ["000000.jpg", "000002.jpg"]
    with pytest.raises(ValueError, match="missing from registered"):
        trainer.Dataset(parser, split="train")


def test_adapter_records_actual_views_and_final_step(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    trainer, parser, _, _, torch = _setup(tmp_path, monkeypatch)
    train = trainer.Dataset(parser, split="train")
    val = trainer.Dataset(parser, split="val")
    item = {
        "image_id": torch.tensor([0]),
        "image": torch.ones((1, 2, 2, 3)),
        "camtoworld": torch.eye(4).unsqueeze(0),
        "K": torch.eye(3).unsqueeze(0),
        "camera_idx": torch.tensor([0]),
    }
    monkeypatch.setattr(torch.utils.data, "DataLoader", lambda *args, **kwargs: [item])
    runner = trainer.Runner()
    runner.trainset, runner.valset, runner.parser = train, val, parser
    runner.world_size, runner.world_rank, runner.device = 1, 0, "cpu"
    runner.cfg = SimpleNamespace(
        data_dir=str(tmp_path),
        result_dir=str(tmp_path / "gsplat"),
        max_steps=10,
        sh_degree=3,
        near_plane=0.01,
        far_plane=100.0,
    )
    runner.render_dir = str(tmp_path / "gsplat" / "renders")
    runner.stats_dir = str(tmp_path / "gsplat" / "stats")
    runner.scene = SimpleNamespace(id="scene")
    runner.stage = SimpleNamespace(render=lambda *args, **kwargs: (torch.zeros((1, 2, 2, 3)), None, None))
    runner.splats = {"means": [1, 2]}
    runner.writer = SimpleNamespace(add_scalar=lambda *args: None, flush=lambda: None)
    runner.psnr = lambda *args: torch.tensor(20.0)
    runner.ssim = lambda *args: torch.tensor(0.5)
    runner.lpips = lambda *args: torch.tensor(0.25)
    runner.eval(9)
    result = json.loads((tmp_path / "gsplat" / "photometric_views.json").read_text(encoding="utf-8"))
    assert result["step"] == 9 and result["split"] == "val"
    assert result["train_source_ids"] == ["a.jpg", "c.jpg"]
    assert result["validation_source_ids"] == ["b.jpg"]
    assert result["views"] == [
        {"source_id": "b.jpg", "image_name": "000001.jpg", "psnr": 20.0, "ssim": 0.5, "lpips": 0.25}
    ]
    run = json.loads((tmp_path / "gsplat" / "run.json").read_text(encoding="utf-8"))
    assert run == {"ply_step": 9, "eval_step": 9}
    val.indices = np.array([0])
    with pytest.raises(ValueError, match="persisted photometric split"):
        runner.eval(9)


def test_dense_initialization_validates_and_transforms_points(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    from types import SimpleNamespace as Namespace

    from rescene.gsplat_runner import _dense_parser

    dense_dir = tmp_path / "dense"
    dense_dir.mkdir()
    (dense_dir / "fused.ply").write_bytes(b"test fixture; the fake reader ignores content")
    count = 2_000
    vertex = np.zeros(
        count, dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")]
    )
    vertex["x"] = np.linspace(0.0, 100.0, count)
    vertex["y"] = np.linspace(-50.0, 50.0, count)
    vertex["z"] = np.linspace(-50.0, 50.0, count)
    vertex["x"][0] = 1.0e6
    vertex["red"] = 200

    class PlyData:
        @staticmethod
        def read(path: str) -> dict[str, Namespace]:
            assert path == str(dense_dir / "fused.ply")
            return {"vertex": Namespace(data=vertex)}

    normalize = Namespace(transform_points=lambda transform, points: np.asarray(points) + np.array([4.0, 0.0, 0.0]))
    monkeypatch.setitem(sys.modules, "plyfile", Namespace(PlyData=PlyData))
    monkeypatch.setitem(sys.modules, "datasets", Namespace(normalize=normalize))
    monkeypatch.setitem(sys.modules, "datasets.normalize", normalize)

    class Base:
        def __init__(self, data_dir: str) -> None:
            self.data_dir = data_dir
            self.transform = np.eye(4)

    parser = _dense_parser(Base)(str(tmp_path))
    assert 100 <= len(parser.points) == len(parser.points_rgb) <= 250_000
    assert np.isfinite(parser.points).all()
    assert parser.points[:, 0].max() < 1.0e5
    assert parser.points[:, 0].min() >= 4.0
    assert (parser.points_rgb[:, 0] == 200).all()
    assert (parser.points_rgb[:, 1:] == 0).all()


def test_dense_initialization_requires_dense_artifacts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    from types import SimpleNamespace as Namespace

    from rescene.gsplat_runner import _dense_parser

    normalize = Namespace(transform_points=lambda transform, points: points)
    monkeypatch.setitem(sys.modules, "plyfile", Namespace())
    monkeypatch.setitem(sys.modules, "datasets.normalize", normalize)

    class Base:
        def __init__(self, data_dir: str) -> None:
            self.data_dir = data_dir
            self.transform = np.eye(4)

    with pytest.raises(ValueError, match="Dense initialization requires"):
        _dense_parser(Base)(str(tmp_path))
