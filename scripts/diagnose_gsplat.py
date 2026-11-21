"""Measure repeatability of the locked CUDA rasterizer on identical Gaussian inputs."""

import statistics


def diagnose() -> dict:
    """Contrast forward images and gradients with PyTorch determinism disabled and enabled."""
    import torch
    from gsplat import rasterization

    device = "cuda"
    generator = torch.Generator(device=device).manual_seed(42)
    count = 8192
    means = torch.rand((count, 3), device=device, generator=generator) - 0.5
    means[:, 2] += 2
    rotations = torch.zeros((count, 4), device=device)
    rotations[:, 0] = 1
    scales = torch.full((count, 3), 0.035, device=device)
    opacity = torch.full((count,), 0.2, device=device)
    rgb = torch.rand((count, 3), device=device, generator=generator)
    view = torch.eye(4, device=device).unsqueeze(0)
    intrinsics = torch.tensor([[[210, 0, 128], [0, 210, 128], [0, 0, 1]]], dtype=torch.float32, device=device)

    results = {}
    names = ("rgb", "means_grad", "rotations_grad", "scales_grad", "opacity_grad", "colors_grad")
    for deterministic in (False, True):
        torch.use_deterministic_algorithms(deterministic)
        for packed in (False, True):
            passes = []
            durations = []
            torch.cuda.reset_peak_memory_stats()
            for repetition in range(9):
                inputs = tuple(x.detach().requires_grad_() for x in (means, rotations, scales, opacity, rgb))
                start = torch.cuda.Event(enable_timing=True)
                stop = torch.cuda.Event(enable_timing=True)
                start.record()
                rendered, _, _ = rasterization(*inputs, view, intrinsics, 256, 256, packed=packed)
                gradients = torch.autograd.grad(rendered.square().mean(), inputs)
                stop.record()
                stop.synchronize()
                if repetition:
                    passes.append(tuple(x.detach().cpu() for x in (rendered, *gradients)))
                    durations.append(start.elapsed_time(stop))
            assert bool(passes[0][0].max() > 0)
            assert all(bool(torch.isfinite(x).all()) for sample in passes for x in sample)
            assert any(bool(x.abs().max() > 0) for x in passes[0][1:])
            outputs = {}
            for name, values in zip(names, zip(*passes, strict=True), strict=True):
                reference, *rest = values
                outputs[name] = {
                    "different_repeats": sum(not torch.equal(reference, x) for x in rest),
                    "max_abs_delta": max(float((reference - x).abs().max()) for x in rest),
                }
            results[f"deterministic={deterministic},packed={packed}"] = {
                "cuda_median_ms": statistics.median(durations),
                "peak_allocated_mib": torch.cuda.max_memory_allocated() / 1024**2,
                "outputs": outputs,
            }
    return {"gpu": torch.cuda.get_device_name(), "torch": torch.__version__, "count": count, "results": results}
