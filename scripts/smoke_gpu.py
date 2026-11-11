"""Minimal CUDA import and gsplat-kernel smoke test."""

import os

import numpy as np
import torch
from gsplat.rendering import rasterization

assert torch.cuda.is_available()
if os.environ.get("RESCENE_EXPECT_5090") == "1":
    assert "RTX 5090" in torch.cuda.get_device_name(0)
    assert torch.cuda.get_device_capability(0) == (12, 0)
    assert torch.cuda.get_device_properties(0).total_memory >= 31 * 1024**3
numpy_sample = np.array([1.0, 2.0], dtype=np.float32)
assert torch.from_numpy(numpy_sample).tolist() == [1.0, 2.0]
means = torch.tensor([[0.0, 0.0, 2.0]], device="cuda")
quats = torch.tensor([[1.0, 0.0, 0.0, 0.0]], device="cuda")
scales = torch.full((1, 3), 0.1, device="cuda")
opacities = torch.ones(1, device="cuda")
colors = torch.ones((1, 3), device="cuda")
viewmats = torch.eye(4, device="cuda")[None]
intrinsics = torch.tensor([[[50.0, 0.0, 16.0], [0.0, 50.0, 16.0], [0.0, 0.0, 1.0]]], device="cuda")
render, _, _ = rasterization(means, quats, scales, opacities, colors, viewmats, intrinsics, 32, 32)
assert render.shape[:3] == (1, 32, 32)

import pycolmap  # noqa: E402,F401
import spz  # noqa: E402,F401
import vggt  # noqa: E402,F401

print(
    {
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "numpy": np.__version__,
    }
)
