"""Quality-first selection rules applied to benchmark leaderboards.

Rules (from the approved plan):

* noise thresholds: PSNR 0.20 dB, SSIM 0.01, LPIPS 0.01, time 5%
* FAST keeps speed: candidate must be at most 0.90x baseline and regress nothing
* BALANCED allows quality at most 1.60x, or speed at most 0.90x
* QUALITY allows quality at most 2.00x and never trades quality for speed
* point and mesh vertex counts are size indicators, not geometry quality evidence
* a promotion also needs validation and holdout passes; missing stages never promote
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

PSNR_MARGIN = 0.20
SSIM_MARGIN = 0.01
LPIPS_MARGIN = 0.01
MARGINS = {"psnr": PSNR_MARGIN, "ssim": SSIM_MARGIN, "lpips": LPIPS_MARGIN}
METRIC_KEYS = ("psnr", "ssim", "lpips")
GEOMETRY_KEYS = ("dense_point_count", "mesh_vertex_count")


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(leaderboard: Any) -> list[dict[str, Any]]:
    rows = leaderboard.get("rows") if isinstance(leaderboard, dict) else leaderboard
    if not isinstance(rows, list):
        raise ValueError("Leaderboard must be a list of rows")
    return rows


def _index(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    return {(row["profile"], row["candidate_id"], row["scene_id"]): row for row in rows}


def _value(row: dict[str, Any] | None, key: str) -> float | None:
    if row is None:
        return None
    values = [row[name] for name in (f"median_{key}", key) if name in row]
    if not values or any(
        not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in values
    ):
        return None
    return float(values[0])


def compare(candidate: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """Return improved/regressed metric names and the wall-clock ratio against baseline."""
    improved: list[str] = []
    regressed: list[str] = []
    for key in METRIC_KEYS:
        reference = _value(baseline, key)
        value = _value(candidate, key)
        if reference is None or value is None:
            continue
        margin = MARGINS[key]
        if key == "lpips":
            if value <= reference - margin:
                improved.append(key)
            elif value > reference + margin:
                regressed.append(key)
        elif value >= reference + margin:
            improved.append(key)
        elif value < reference - margin:
            regressed.append(key)
    baseline_seconds = _value(baseline, "seconds")
    seconds = _value(candidate, "seconds")
    missing = [key for key in METRIC_KEYS if _value(candidate, key) is None or _value(baseline, key) is None]
    if seconds is None or baseline_seconds is None or seconds <= 0 or baseline_seconds <= 0:
        missing.append("seconds")
    comparison: dict[str, Any] = {
        "improved": improved,
        "regressed": regressed,
        "missing": missing,
        "time_ratio": seconds / baseline_seconds if "seconds" not in missing else None,
    }
    for key in GEOMETRY_KEYS:
        comparison[key] = _value(candidate, key)
        comparison[f"baseline_{key}"] = _value(baseline, key)
    return comparison


def _quality_pass(comparison: dict[str, Any], time_limit: float) -> tuple[bool, str]:
    if comparison["missing"]:
        return False, "missing:" + ",".join(comparison["missing"])
    if comparison["regressed"]:
        return False, "regressed:" + ",".join(comparison["regressed"])
    if len(comparison["improved"]) < 2:
        return False, "fewer_than_two_improvements"
    ratio = comparison["time_ratio"]
    if ratio is not None and ratio > time_limit:
        return False, f"too_slow:{ratio:.2f}x"
    return True, "improved"


def _speed_pass(comparison: dict[str, Any], limit: float) -> tuple[bool, str]:
    if comparison["missing"]:
        return False, "missing:" + ",".join(comparison["missing"])
    if comparison["regressed"]:
        return False, "regressed:" + ",".join(comparison["regressed"])
    ratio = comparison["time_ratio"]
    if ratio is None or ratio > limit:
        return False, f"not_fast_enough:{ratio}"
    return True, "faster"


def _rank(row: dict[str, Any]) -> tuple[float, float, float]:
    return (_value(row, "psnr") or 0.0, _value(row, "ssim") or 0.0, -(_value(row, "lpips") or 0.0))


def select_profile(profile: str, candidates: dict[str, dict[str, Any]], scene_id: str) -> dict[str, Any]:
    """Decide the screening winner for one profile on one scene."""
    baseline = candidates.get("baseline")
    decision: dict[str, Any] = {
        "profile": profile,
        "scene_id": scene_id,
        "candidates": [],
        "winner": "baseline",
        "render_winner": None,
        "geometry_winner": None,
        "reason": "baseline_retained",
    }
    if baseline is None:
        decision["reason"] = "missing_baseline"
        return decision

    evaluated: list[dict[str, Any]] = []
    for candidate_id, row in sorted(candidates.items()):
        if candidate_id == "baseline":
            continue
        comparison = compare(row, baseline)
        if profile == "fast":
            passed, reason = _speed_pass(comparison, 0.90)
        elif profile == "balanced":
            quality_ok, quality_reason = _quality_pass(comparison, 1.60)
            speed_ok, speed_reason = _speed_pass(comparison, 0.90)
            if quality_ok:
                passed, reason = True, quality_reason
            elif speed_ok:
                passed, reason = True, speed_reason
            else:
                passed = False
                reason = f"quality[{quality_reason}] speed[{speed_reason}]"
        else:
            passed, reason = _quality_pass(comparison, 2.00)
        evaluated.append(
            {"candidate_id": candidate_id, "passed": passed, "reason": reason, "rank": _rank(row), **comparison}
        )
    decision["candidates"] = [{key: value for key, value in item.items() if key != "rank"} for item in evaluated]

    passing = [item for item in evaluated if item["passed"]]
    if not passing:
        return decision
    if profile == "fast":
        fastest = min(passing, key=lambda item: item["time_ratio"] or float("inf"))
        decision.update({"winner": fastest["candidate_id"], "reason": "fastest_without_regression"})
        return decision

    quality = [item for item in passing if item["improved"]]
    if quality:
        best = max(quality, key=lambda item: item["rank"])
        decision.update({"winner": best["candidate_id"], "render_winner": best["candidate_id"], "reason": "quality"})
        return decision
    if profile == "balanced":
        fastest = min(passing, key=lambda item: item["time_ratio"] or float("inf"))
        decision.update({"winner": fastest["candidate_id"], "reason": "faster_without_regression"})
    return decision


def check_stage(
    profile: str,
    candidate_id: str,
    stage_rows: list[dict[str, Any]],
    *,
    time_limit: float,
    required_improvements: int,
) -> dict[str, Any]:
    """Review one candidate on a validation or holdout stage."""
    index = _index(stage_rows)
    scenes = sorted({row["scene_id"] for row in stage_rows if row["profile"] == profile})
    details: list[dict[str, Any]] = []
    improved_scenes = 0
    for scene_id in scenes:
        baseline = index.get((profile, "baseline", scene_id))
        candidate = index.get((profile, candidate_id, scene_id))
        if candidate is None or baseline is None:
            details.append({"scene_id": scene_id, "status": "missing"})
            continue
        comparison = compare(candidate, baseline)
        status = "pass"
        if comparison["missing"]:
            status = "missing_metrics"
        elif comparison["regressed"]:
            status = "regressed"
        elif comparison["time_ratio"] is not None and comparison["time_ratio"] > time_limit:
            status = "too_slow"
        if len(comparison["improved"]) >= required_improvements:
            improved_scenes += 1
        details.append({"scene_id": scene_id, "status": status, **comparison})
    passed = bool(details) and all(item["status"] == "pass" for item in details)
    if passed and required_improvements and improved_scenes < -(-len(scenes) * 2 // 3):
        passed = False
    return {"passed": passed, "scenes": details, "improved_scenes": improved_scenes}
