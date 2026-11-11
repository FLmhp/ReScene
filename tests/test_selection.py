"""Selection rules must keep FAST fast, QUALITY honest, and never promote on partial evidence."""

from __future__ import annotations

from typing import Any

from rescene.selection import check_stage, compare, select_profile


def _row(
    candidate_id: str,
    *,
    psnr: float,
    ssim: float,
    lpips: float,
    seconds: float,
    profile: str = "balanced",
    scene: str = "kitchen",
    **extra: Any,
) -> dict[str, Any]:
    row = {
        "profile": profile,
        "candidate_id": candidate_id,
        "scene_id": scene,
        "median_psnr": psnr,
        "median_ssim": ssim,
        "median_lpips": lpips,
        "median_seconds": seconds,
    }
    row.update(extra)
    return row


BASELINE = _row("baseline", psnr=20.0, ssim=0.700, lpips=0.300, seconds=100.0)


def test_compare_uses_noise_thresholds() -> None:
    inside = compare(_row("c", psnr=20.1, ssim=0.705, lpips=0.295, seconds=100.0), BASELINE)
    assert inside["improved"] == [] and inside["regressed"] == []

    outside = compare(_row("c", psnr=20.3, ssim=0.68, lpips=0.32, seconds=50.0), BASELINE)
    assert outside["improved"] == ["psnr"]
    assert outside["regressed"] == ["ssim", "lpips"]
    assert outside["time_ratio"] == 0.5


def test_fast_picks_fastest_without_regression() -> None:
    candidates = {
        "baseline": _row("baseline", psnr=20.0, ssim=0.700, lpips=0.300, seconds=100.0, profile="fast"),
        "slow_clear": _row("slow_clear", psnr=21.0, ssim=0.750, lpips=0.250, seconds=95.0, profile="fast"),
        "fast_better": _row("fast_better", psnr=20.5, ssim=0.705, lpips=0.295, seconds=70.0, profile="fast"),
        "fast_worse": _row("fast_worse", psnr=19.0, ssim=0.600, lpips=0.400, seconds=40.0, profile="fast"),
    }

    decision = select_profile("fast", candidates, "kitchen")

    assert decision["winner"] == "fast_better"
    assert decision["reason"] == "fastest_without_regression"


def test_balanced_prefers_quality_inside_budget() -> None:
    candidates = {
        "baseline": BASELINE,
        "appearance": _row("appearance", psnr=20.5, ssim=0.730, lpips=0.270, seconds=140.0),
        "slow_appearance": _row("slow_appearance", psnr=21.5, ssim=0.760, lpips=0.240, seconds=170.0),
    }

    decision = select_profile("balanced", candidates, "kitchen")

    assert decision["winner"] == "appearance"
    assert decision["render_winner"] == "appearance"
    reasons = {item["candidate_id"]: item["reason"] for item in decision["candidates"]}
    assert "too_slow" in reasons["slow_appearance"]


def test_quality_never_trades_quality_for_speed() -> None:
    candidates = {
        "baseline": _row("baseline", psnr=24.0, ssim=0.72, lpips=0.26, seconds=400.0, profile="quality"),
        "cheap": _row("cheap", psnr=23.4, ssim=0.70, lpips=0.28, seconds=200.0, profile="quality"),
        "better": _row("better", psnr=24.6, ssim=0.74, lpips=0.24, seconds=600.0, profile="quality"),
    }

    decision = select_profile("quality", candidates, "kitchen")

    assert decision["winner"] == "better"
    reasons = {item["candidate_id"]: item["reason"] for item in decision["candidates"]}
    assert reasons["cheap"] == "regressed:psnr,ssim,lpips"


def test_geometry_candidate_needs_point_cloud_retention() -> None:
    baseline = _row(
        "baseline",
        psnr=24.0,
        ssim=0.72,
        lpips=0.26,
        seconds=400.0,
        profile="quality",
        median_dense_point_count=1000.0,
        median_mesh_vertex_count=500.0,
    )
    kept = _row(
        "mvs1200",
        psnr=24.0,
        ssim=0.72,
        lpips=0.26,
        seconds=500.0,
        profile="quality",
        median_dense_point_count=1200.0,
        median_mesh_vertex_count=600.0,
    )
    dropped = _row(
        "poisson12",
        psnr=24.0,
        ssim=0.72,
        lpips=0.26,
        seconds=450.0,
        profile="quality",
        median_dense_point_count=1000.0,
        median_mesh_vertex_count=100.0,
    )

    decision = select_profile("quality", {"baseline": baseline, "mvs1200": kept, "poisson12": dropped}, "kitchen")

    # Point and vertex counts describe size, not geometric accuracy.
    assert decision["winner"] == "baseline"
    assert decision["reason"] == "baseline_retained"
    assert decision["geometry_winner"] is None
    reasons = {item["candidate_id"]: item["reason"] for item in decision["candidates"]}
    assert reasons == {"mvs1200": "fewer_than_two_improvements", "poisson12": "fewer_than_two_improvements"}


def test_check_stage_rejects_any_regressed_scene() -> None:
    rows = [
        _row("baseline", psnr=20.0, ssim=0.70, lpips=0.30, seconds=100.0, scene="fern"),
        _row("appearance", psnr=20.6, ssim=0.73, lpips=0.27, seconds=130.0, scene="fern"),
        _row("baseline", psnr=21.0, ssim=0.71, lpips=0.31, seconds=90.0, scene="flower"),
        _row("appearance", psnr=20.5, ssim=0.70, lpips=0.33, seconds=120.0, scene="flower"),
    ]

    result = check_stage("balanced", "appearance", rows, time_limit=1.6, required_improvements=2)

    assert not result["passed"]
    statuses = {item["scene_id"]: item["status"] for item in result["scenes"]}
    assert statuses == {"fern": "pass", "flower": "regressed"}


def test_check_stage_requires_improvement_coverage() -> None:
    rows = [
        _row("baseline", psnr=20.0, ssim=0.70, lpips=0.30, seconds=100.0, scene="fern"),
        _row("appearance", psnr=20.6, ssim=0.73, lpips=0.27, seconds=110.0, scene="fern"),
        _row("baseline", psnr=21.0, ssim=0.71, lpips=0.31, seconds=100.0, scene="flower"),
        _row("appearance", psnr=21.1, ssim=0.715, lpips=0.305, seconds=110.0, scene="flower"),
        _row("baseline", psnr=20.0, ssim=0.70, lpips=0.30, seconds=100.0, scene="playground"),
        _row("appearance", psnr=20.1, ssim=0.705, lpips=0.295, seconds=110.0, scene="playground"),
    ]

    result = check_stage("balanced", "appearance", rows, time_limit=1.6, required_improvements=2)

    assert result["improved_scenes"] == 1
    assert not result["passed"]
    assert all(item["status"] == "pass" for item in result["scenes"])


def test_nonfinite_or_missing_metrics_cannot_promote_fast_candidate() -> None:
    for invalid in (None, float("nan"), float("inf")):
        candidate = _row("candidate", psnr=20.0, ssim=0.7, lpips=0.3, seconds=50.0, profile="fast")
        candidate["psnr"] = invalid
        baseline = _row("baseline", psnr=20.0, ssim=0.7, lpips=0.3, seconds=100.0, profile="fast")
        decision = select_profile("fast", {"baseline": baseline, "candidate": candidate}, "kitchen")
        assert decision["winner"] == "baseline"
        result = check_stage("fast", "candidate", [baseline, candidate], time_limit=1.6, required_improvements=0)
        assert not result["passed"]
        assert result["scenes"][0]["status"] == "missing_metrics"
        for bad_row in (candidate, baseline):
            candidate.pop("psnr", None)
            bad_row["median_psnr"] = invalid
            decision = select_profile("fast", {"baseline": baseline, "candidate": candidate}, "kitchen")
            assert decision["winner"] == "baseline"
            result = check_stage("fast", "candidate", [baseline, candidate], time_limit=1.6, required_improvements=0)
            assert not result["passed"]
            bad_row["median_psnr"] = 20.0


def test_fast_validation_accepts_speed_without_quality_gain() -> None:
    rows = [
        _row("baseline", psnr=20.0, ssim=0.70, lpips=0.30, seconds=100.0, profile="fast", scene="fern"),
        _row("steps5k", psnr=20.0, ssim=0.70, lpips=0.30, seconds=80.0, profile="fast", scene="fern"),
        _row("baseline", psnr=21.0, ssim=0.71, lpips=0.31, seconds=100.0, profile="fast", scene="flower"),
        _row("steps5k", psnr=21.0, ssim=0.71, lpips=0.31, seconds=80.0, profile="fast", scene="flower"),
    ]

    speed_only = check_stage("fast", "steps5k", rows, time_limit=1.6, required_improvements=0)
    quality_required = check_stage("fast", "steps5k", rows, time_limit=1.6, required_improvements=2)

    assert speed_only["passed"]
    assert not quality_required["passed"]
