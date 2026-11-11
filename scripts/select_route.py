"""CLI wrapper around rescene.selection for the 5090 quality-first round."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from rescene.selection import check_stage, select_profile

PROFILES = ("fast", "balanced", "quality")


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(leaderboard: Any) -> list[dict[str, Any]]:
    rows = leaderboard.get("rows") if isinstance(leaderboard, dict) else leaderboard
    if not isinstance(rows, list):
        raise ValueError("Leaderboard must be a list of rows")
    return rows


def _overrides_for(
    profile: str, decision: dict[str, Any], candidates: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    overrides: dict[str, Any] = {}
    for candidate_id in (decision["render_winner"], decision["geometry_winner"]):
        if not candidate_id:
            continue
        for entry in candidates[profile]:
            if entry["id"] == candidate_id:
                overrides.update(entry.get("overrides", {}))
    return overrides


def _winner_entry(
    profile: str, decision: dict[str, Any], candidates: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    for entry in candidates[profile]:
        if entry["id"] == decision["winner"]:
            return {
                "id": entry["id"],
                "estimated_minutes": entry.get("estimated_minutes", 15),
                "overrides": dict(entry.get("overrides", {})),
            }
    return {"id": "baseline", "estimated_minutes": 15, "overrides": {}}


def _stage_candidates(
    profile: str, decision: dict[str, Any], candidates: dict[str, list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    """Return baseline + winner so later stages can still compare against baseline."""
    baseline = next(
        (entry for entry in candidates[profile] if entry["id"] == "baseline"),
        {"id": "baseline", "estimated_minutes": 15, "overrides": {}},
    )
    entries = [
        {
            "id": "baseline",
            "estimated_minutes": baseline.get("estimated_minutes", 15),
            "overrides": dict(baseline.get("overrides", {})),
        }
    ]
    winner = _winner_entry(profile, decision, candidates)
    if winner["id"] != "baseline":
        entries.append(winner)
    return entries


def _selected(
    profile: str,
    output_id: str,
    source_id: str,
    overrides: dict[str, Any],
    candidates: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Return the selected profile in candidates-file shape, so it can be re-run."""
    minutes = next(
        (entry.get("estimated_minutes", 15) for entry in candidates[profile] if entry["id"] == source_id),
        15,
    )
    return [{"id": output_id, "estimated_minutes": minutes, "overrides": overrides}]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screen", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--validation", type=Path)
    parser.add_argument("--holdout", type=Path)
    parser.add_argument("--screen-scene", default="golden-kitchen")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selected", type=Path)
    parser.add_argument("--winners", type=Path)
    args = parser.parse_args()

    screen_rows = _rows(_read(args.screen))
    candidates = _read(args.candidates)["profiles"]
    validation_rows = _rows(_read(args.validation)) if args.validation and args.validation.is_file() else []
    holdout_rows = _rows(_read(args.holdout)) if args.holdout and args.holdout.is_file() else []

    selection: dict[str, Any] = {"schema_version": 1, "screen": str(args.screen), "profiles": {}}
    selected: dict[str, Any] = {"schema_version": 1, "profiles": {}}
    winners: dict[str, Any] = {"schema_version": 1, "profiles": {}}

    for profile in PROFILES:
        rows = {
            row["candidate_id"]: row
            for row in screen_rows
            if row["profile"] == profile and row["scene_id"] == args.screen_scene
        }
        decision = select_profile(profile, rows, args.screen_scene)
        record: dict[str, Any] = {"screen": decision, "validation": None, "holdout": None, "promoted": False}
        winner = decision["winner"]
        winners["profiles"][profile] = _stage_candidates(profile, decision, candidates)
        if winner == "baseline":
            selected["profiles"][profile] = _selected(profile, "baseline", "baseline", {}, candidates)
            selection["profiles"][profile] = record
            continue
        time_limit = 1.7 if profile == "quality" else 1.6
        # FAST is optimized for latency: validation must confirm the speed-up
        # holds and nothing regresses, not that rendering quality improves.
        required_improvements = 0 if profile == "fast" else 2
        validation = (
            check_stage(
                profile, winner, validation_rows, time_limit=time_limit, required_improvements=required_improvements
            )
            if validation_rows
            else {"passed": False, "reason": "not_run", "scenes": []}
        )
        holdout = (
            check_stage(profile, winner, holdout_rows, time_limit=1.8, required_improvements=0)
            if holdout_rows
            else {"passed": False, "reason": "not_run", "scenes": []}
        )
        record.update({"validation": validation, "holdout": holdout})
        record["promoted"] = bool(validation["passed"] and holdout["passed"])
        if record["promoted"]:
            selected["profiles"][profile] = _selected(
                profile, f"promoted-{winner}", winner, _overrides_for(profile, decision, candidates), candidates
            )
        else:
            selected["profiles"][profile] = _selected(profile, "baseline", "baseline", {}, candidates)
        selection["profiles"][profile] = record

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.selected:
        args.selected.parent.mkdir(parents=True, exist_ok=True)
        args.selected.write_text(json.dumps(selected, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.winners:
        args.winners.parent.mkdir(parents=True, exist_ok=True)
        args.winners.write_text(json.dumps(winners, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps({profile: entries[0]["id"] for profile, entries in selected["profiles"].items()}, ensure_ascii=False)
    )


if __name__ == "__main__":
    main()
