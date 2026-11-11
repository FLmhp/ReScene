"""Render the calibration leaderboards as markdown tables for the report.

Reads `calibration/route-*/leaderboard.json`, `calibration/selection-v2.json` and
`calibration/route-holdout-v2/official.json` when present and prints one table
per stage. Missing files are skipped so the script works mid-run.

Usage: scripts/summarize_calibration.py [--root calibration]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

METRICS = (
    "median_psnr",
    "median_ssim",
    "median_lpips",
    "median_dense_point_count",
    "median_mesh_vertex_count",
)


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    value = _read(path)
    rows = value.get("rows") if isinstance(value, dict) else value
    return rows if isinstance(rows, list) else []


def _number(value: Any, digits: int = 2) -> str:
    return "-" if not isinstance(value, (int, float)) or isinstance(value, bool) else f"{value:.{digits}f}"


def _screen_table(rows: list[dict[str, Any]]) -> list[str]:
    lines = [
        "| 档位 | 候选 | 耗时 s | 相对基线 | PSNR | SSIM | LPIPS | 稠密点 | 网格顶点 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    baselines = {row["profile"]: row for row in rows if row["candidate_id"] == "baseline"}
    for row in sorted(rows, key=lambda item: (item["profile"], item["candidate_id"])):
        baseline = baselines.get(row["profile"])
        seconds, base_seconds = row.get("median_seconds"), (baseline or {}).get("median_seconds")
        ratio = seconds / base_seconds if seconds and base_seconds else None
        cells = [
            row["profile"],
            row["candidate_id"],
            _number(seconds, 0),
            f"{ratio:.2f}x" if ratio else "-",
            *(_number(row.get(key)) for key in METRICS),
        ]
        lines.append("| " + " | ".join(str(cell) for cell in cells) + " |")
    return lines


def _stage_table(rows: list[dict[str, Any]]) -> list[str]:
    lines = ["| 档位 | 候选 | 场景 | 耗时 s | PSNR | SSIM | LPIPS | 注册率 |", "|---|---|---|---|---|---|---|---|"]
    for row in sorted(rows, key=lambda item: (item["profile"], item["candidate_id"], item["scene_id"])):
        registration = row.get("median_validation_registration_rate", row.get("validation_registration_rate"))
        cells = [
            row["profile"],
            row["candidate_id"],
            row["scene_id"],
            _number(row.get("median_seconds"), 0),
            *(_number(row.get(key)) for key in ("median_psnr", "median_ssim", "median_lpips")),
            _number(registration) if registration is not None else "-",
        ]
        lines.append("| " + " | ".join(str(cell) for cell in cells) + " |")
    return lines


def _selection_table(selection: dict[str, Any], selected: dict[str, Any]) -> list[str]:
    chosen = selected.get("profiles") or {}
    lines = [
        "| 档位 | 屏幕 winner | 晋级 | 校验场景 | holdout | 最终配置 |",
        "|---|---|---|---|---|---|",
    ]
    for profile, record in selection.get("profiles", {}).items():
        screen = record.get("screen") or {}
        validation = record.get("validation") or {}
        holdout = record.get("holdout") or {}
        entries = chosen.get(profile) or []
        final = entries[0].get("id") if entries else "-"
        improved = validation.get("improved_scenes")
        if isinstance(improved, list):
            scenes = ", ".join(str(item) for item in improved) or "-"
        elif isinstance(improved, int):
            scenes = str(improved)
        else:
            scenes = "-"
        lines.append(
            "| {profile} | {winner} ({reason}) | {promoted} | {scenes} | {holdout} | {final} |".format(
                profile=profile,
                winner=screen.get("winner", "-"),
                reason=screen.get("reason", "-"),
                promoted="是" if record.get("promoted") else "否",
                scenes=scenes,
                holdout="通过" if holdout.get("passed") else "-",
                final=final,
            )
        )
    return lines


def _official_table(rows: list[dict[str, Any]]) -> list[str]:
    lines = ["| 档位 | 候选 | 场景 | accuracy | completeness | F1 |", "|---|---|---|---|---|---|"]
    for row in sorted(rows, key=lambda item: (item["profile"], item["candidate_id"], item["scene_id"])):
        cells = [
            row["profile"],
            row["candidate_id"],
            row["scene_id"],
            *(_number(row.get(key), 3) for key in ("point_accuracy", "point_completeness", "point_fscore")),
        ]
        lines.append("| " + " | ".join(str(cell) for cell in cells) + " |")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("calibration"))
    args = parser.parse_args()

    sections = [
        ("屏幕集 (golden-kitchen)", _rows(args.root / "route-screen-v2/leaderboard.json"), _screen_table),
        ("验证集 (fern/flower/playground)", _rows(args.root / "route-validation-v2/leaderboard.json"), _stage_table),
        ("Holdout (courtyard/office)", _rows(args.root / "route-holdout-v2/leaderboard.json"), _stage_table),
    ]
    for title, rows, render in sections:
        print(f"### {title}\n")
        if not rows:
            print("_未运行_\n")
            continue
        print("\n".join(render(rows)))
        print()

    selection_path = args.root / "selection-v2.json"
    selected_path = args.root.parent / "configs/calibration/selected-v2.json"
    print("### 选型\n")
    if selection_path.is_file():
        selected = _read(selected_path) if selected_path.is_file() else {}
        print("\n".join(_selection_table(_read(selection_path), selected)))
    else:
        print("_未运行_")
    print()

    official = _rows(args.root / "route-holdout-v2/official.json")
    print("### ETH3D 官方评测 (0.02 m)\n")
    if official:
        print("\n".join(_official_table(official)))
    else:
        print("_未运行_")


if __name__ == "__main__":
    main()
