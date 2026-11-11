"""Score the ETH3D holdout runs with the official benchmark evaluator.

Scoring aligns each reconstruction to a reference COLMAP model before comparing
it against the scene's `scan_eval/scan_alignment.mlp`.

Usage:
  scripts/evaluate_holdout.py --leaderboard calibration/route-holdout-v2/leaderboard.json \
      --evaluator .cache/dataset-pipeline/build/ETH3D_benchmark \
      --output calibration/route-holdout-v2/official.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from rescene.evaluation import evaluate_run


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(value: Any) -> list[dict[str, Any]]:
    rows = value.get("rows") if isinstance(value, dict) else value
    if not isinstance(rows, list):
        raise ValueError("Leaderboard must be a list of rows")
    return rows


def _scenes(manifest: Path) -> dict[str, Path]:
    scenes = _read(manifest)["scenes"]
    return {str(scene["id"]): Path(str(scene["input"])) for scene in scenes}


def _reference_model(scene_dir: Path) -> Path:
    """Return the ETH3D COLMAP model used to align the reconstruction."""
    for name in ("dslr_calibration_undistorted", "dslr_calibration_jpg"):
        candidate = scene_dir / name
        if any(
            (candidate / f"cameras.{extension}").is_file() and (candidate / f"images.{extension}").is_file()
            for extension in ("bin", "txt")
        ):
            return candidate
    raise FileNotFoundError(f"No COLMAP reference model in {scene_dir}")


def _ground_truth(input_dir: Path) -> Path:
    """Return `<scene>/scan_eval/scan_alignment.mlp` for an ETH3D image directory."""
    scene_dir = input_dir.parent
    for name in ("dslr_scan_eval", "scan_eval"):
        preferred = scene_dir / name / "scan_alignment.mlp"
        if preferred.is_file():
            return preferred
    candidates = sorted(scene_dir.glob("*scan_eval/*.mlp"))
    if not candidates:
        raise FileNotFoundError(f"No scan alignment next to {input_dir}")
    return candidates[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--leaderboard", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=Path("configs/datasets/route-holdout-v2.json"))
    parser.add_argument("--runs-root", type=Path, default=Path("runs"))
    parser.add_argument("--evaluator", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.02)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    scenes = _scenes(args.manifest)
    results: list[dict[str, Any]] = []
    skipped: list[str] = []
    for row in _rows(_read(args.leaderboard)):
        scene_id = str(row["scene_id"])
        if scene_id not in scenes:
            continue
        run_ids = [str(row["run_id"])] if row.get("run_id") else [str(item) for item in row.get("runs") or []]
        if not run_ids:
            skipped.append(f"{row.get('profile')}/{row.get('candidate_id')}/{scene_id}: no run ids")
            continue
        for run_id in run_ids:
            run_dir = args.runs_root / run_id
            if not run_dir.is_dir():
                skipped.append(f"{run_id}: missing run directory")
                continue
            metrics = evaluate_run(
                run_dir,
                _reference_model(scenes[scene_id].parent),
                _ground_truth(scenes[scene_id]),
                args.threshold,
                args.evaluator,
            )
            results.append(
                {
                    "run_id": run_id,
                    "profile": row["profile"],
                    "candidate_id": row["candidate_id"],
                    "scene_id": scene_id,
                    "point_accuracy": metrics.get("point_accuracy"),
                    "point_completeness": metrics.get("point_completeness"),
                    "point_fscore": metrics.get("point_fscore"),
                    "point_metric_method": metrics.get("point_metric_method"),
                }
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps({"schema_version": 1, "threshold": args.threshold, "rows": results, "skipped": skipped}, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"scored": len(results), "skipped": len(skipped)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
