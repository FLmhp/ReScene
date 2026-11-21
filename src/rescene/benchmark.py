"""Dataset-driven calibration using the existing reconstruction pipeline."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rescene.config import ProfileConfig, profile_config
from rescene.metrics import sha256_file
from rescene.pipeline import project_root, run_pipeline

PROFILE_NAMES = ("fast", "balanced", "quality")
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True)
class Trial:
    """One deterministic profile/candidate/scene experiment."""

    profile: str
    candidate_id: str
    dataset_id: str
    scene_id: str
    split: str
    input_path: Path
    config: ProfileConfig
    run_id: str
    estimated_minutes: float
    repeat: int = 1

    def to_dict(self) -> dict[str, object]:
        """Return the stable execution-plan representation."""
        return {
            "profile": self.profile,
            "candidate_id": self.candidate_id,
            "dataset_id": self.dataset_id,
            "scene_id": self.scene_id,
            "split": self.split,
            "input": str(self.input_path),
            "run_id": self.run_id,
            "repeat": self.repeat,
            "estimated_minutes": self.estimated_minutes,
            "config": self.config.to_dict(),
            "config_hash": _config_hash(self.config),
        }


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read JSON configuration {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Configuration must be a JSON object: {path}")
    return value


def _write_json_atomic(path: Path, value: object) -> None:
    staging = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    os.replace(staging, path)


def _trial_metrics(path: Path) -> dict[str, Any] | None:
    """Return a trial's metrics only when the file is a complete, readable result."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or "total_seconds" not in value:
        return None
    return value


def _config_hash(config: ProfileConfig) -> str:
    encoded = json.dumps(config.to_dict(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _valid_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ValueError(f"{label} must contain only letters, numbers, dot, underscore, or dash")
    return value


def load_dataset_manifest(path: Path) -> dict[str, Any]:
    """Load and validate scene-level calibration/test splits."""
    manifest = _read_json(path)
    if manifest.get("license_target") != "academic-noncommercial":
        raise ValueError("Dataset manifest must declare license_target=academic-noncommercial")
    scenes = manifest.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("Dataset manifest must contain a non-empty scenes list")
    seen: set[str] = set()
    for scene in scenes:
        if not isinstance(scene, dict):
            raise ValueError("Each dataset scene must be an object")
        scene_id = _valid_id(scene.get("id"), "scene id")
        _valid_id(scene.get("dataset"), "dataset id")
        if scene_id in seen:
            raise ValueError(f"Duplicate scene id: {scene_id}")
        seen.add(scene_id)
        split = scene.get("split")
        if split not in {"calibration", "test"}:
            raise ValueError(f"Scene {scene_id} has invalid split: {split}")
        if not isinstance(scene.get("input"), str) or not scene["input"]:
            raise ValueError(f"Scene {scene_id} is missing input")
    return manifest


def load_candidates(path: Path) -> dict[str, list[dict[str, Any]]]:
    """Load candidates and validate every override against ProfileConfig."""
    value = _read_json(path).get("profiles")
    if not isinstance(value, dict):
        raise ValueError("Candidate configuration must contain a profiles object")
    candidates: dict[str, list[dict[str, Any]]] = {}
    for profile, entries in value.items():
        if profile not in PROFILE_NAMES or not isinstance(entries, list) or not entries:
            raise ValueError(f"Invalid candidate profile: {profile}")
        ids: set[str] = set()
        validated: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError(f"Candidates for {profile} must be objects")
            candidate_id = _valid_id(entry.get("id"), "candidate id")
            if candidate_id in ids:
                raise ValueError(f"Duplicate candidate id for {profile}: {candidate_id}")
            ids.add(candidate_id)
            overrides = entry.get("overrides", {})
            if not isinstance(overrides, dict):
                raise ValueError(f"Overrides for {profile}/{candidate_id} must be an object")
            config = profile_config(profile).with_overrides(overrides)
            estimated = entry.get("estimated_minutes", 15)
            if not isinstance(estimated, (int, float)) or isinstance(estimated, bool) or estimated <= 0:
                raise ValueError(f"estimated_minutes must be positive for {profile}/{candidate_id}")
            validated.append({"id": candidate_id, "config": config, "estimated_minutes": float(estimated)})
        if "baseline" not in ids:
            raise ValueError(f"Profile {profile} must define a baseline candidate")
        candidates[profile] = validated
    return candidates


def build_trials(
    manifest_path: Path,
    candidates_path: Path,
    profiles: list[str],
    run_prefix: str,
    *,
    split: str = "calibration",
    repeat: int = 1,
) -> list[Trial]:
    """Expand profiles, scenes, candidates, and repeats into an ordered trial plan."""
    manifest = load_dataset_manifest(manifest_path)
    candidates = load_candidates(candidates_path)
    _valid_id(run_prefix, "run prefix")
    if split == "validation":
        # Validation scenes live in their own manifest and are marked calibration there.
        split = "calibration"
    if split not in {"calibration", "test"}:
        raise ValueError(f"Unknown split: {split}")
    if repeat < 1:
        raise ValueError("repeat must be at least 1")
    unknown = set(profiles) - set(PROFILE_NAMES)
    if unknown:
        raise ValueError(f"Unknown profiles: {', '.join(sorted(unknown))}")
    scenes = [scene for scene in manifest["scenes"] if scene["split"] == split]
    if not scenes:
        raise ValueError(f"Dataset manifest has no scenes in split {split}")
    trials: list[Trial] = []
    for profile in profiles:
        if profile not in candidates:
            raise ValueError(f"No candidates configured for profile: {profile}")
        for scene in scenes:
            for candidate in candidates[profile]:
                scene_id = str(scene["id"])
                candidate_id = str(candidate["id"])
                base_id = f"{run_prefix}-{profile}-{candidate_id}-{scene_id}"
                for index in range(repeat):
                    trials.append(
                        Trial(
                            profile=profile,
                            candidate_id=candidate_id,
                            dataset_id=str(scene["dataset"]),
                            scene_id=scene_id,
                            split=split,
                            input_path=Path(str(scene["input"])),
                            config=candidate["config"],
                            run_id=base_id if index == 0 else f"{base_id}-r{index + 1}",
                            estimated_minutes=float(candidate["estimated_minutes"]),
                            repeat=index + 1,
                        )
                    )
    return trials


def _median(values: list[object]) -> float | None:
    numbers = sorted(
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    )
    if not numbers:
        return None
    middle = len(numbers) // 2
    return numbers[middle] if len(numbers) % 2 else (numbers[middle - 1] + numbers[middle]) / 2


def _metric(root: Path, trial: Trial) -> dict[str, Any] | None:
    return _trial_metrics(root / trial.run_id / "metrics.json")


def _selected_set(metrics_list: list[dict[str, Any]]) -> set[str]:
    """Validation frames selected by every completed run of one candidate."""
    if not metrics_list:
        return set()
    return set.intersection(*[set(metrics.get("validation_selected") or []) for metrics in metrics_list])


def _common_validation(
    baseline_selected: set[str],
    candidate_metrics: list[dict[str, Any]],
    candidate_selected: set[str],
) -> dict[str, object]:
    """Compare registration only on validation frames both candidates selected."""
    common = baseline_selected & candidate_selected
    if not common:
        return {
            "common_validation_frames_total": 0,
            "common_validation_registered": None,
            "common_validation_registration_rate": None,
        }
    registered = _median(
        [len(common & set(metrics.get("validation_registered_frames") or [])) for metrics in candidate_metrics]
    )
    return {
        "common_validation_frames_total": len(common),
        "common_validation_registered": None if registered is None else int(registered),
        "common_validation_registration_rate": None if registered is None else registered / len(common),
    }


def _leaderboard(root: Path, trials: list[Trial]) -> list[dict[str, object]]:
    """Aggregate repeats per profile/candidate/scene and compare against baseline."""
    rows: list[dict[str, object]] = []
    scalar_keys = (
        "registration_rate",
        "reprojection_error",
        "total_seconds",
        "psnr",
        "ssim",
        "lpips",
        "dense_point_count",
        "mesh_vertex_count",
        "validation_registration_rate",
        "validation_registered",
        "validation_frames_total",
    )
    groups = sorted({(trial.profile, trial.candidate_id, trial.scene_id) for trial in trials})
    for profile, candidate_id, scene_id in groups:
        matching = [
            trial
            for trial in trials
            if (trial.profile, trial.candidate_id, trial.scene_id) == (profile, candidate_id, scene_id)
        ]
        metrics_list = [metrics for trial in matching if (metrics := _metric(root, trial)) is not None]
        row: dict[str, object] = {
            "profile": profile,
            "candidate_id": candidate_id,
            "scene_id": scene_id,
            "split": matching[0].split,
            "runs": [trial.run_id for trial in matching],
            "repeat_count": len(matching),
            "completed_runs": len(metrics_list),
        }
        row["median_seconds"] = _median([item.get("total_seconds") for item in metrics_list])
        for key in scalar_keys:
            row[f"median_{key}"] = _median([item.get(key) for item in metrics_list])
        baseline_metrics = [
            metrics
            for trial in trials
            if (trial.profile, trial.candidate_id, trial.scene_id) == (profile, "baseline", scene_id)
            if (metrics := _metric(root, trial)) is not None
        ]
        row.update(_common_validation(_selected_set(baseline_metrics), metrics_list, _selected_set(metrics_list)))
        rows.append(row)
    return rows


DEFAULT_VALIDATION_FRAMES = Path("configs/calibration/validation-frames-v2.json")


def load_validation_frames(path: Path) -> dict[str, set[str]]:
    """Load frozen validation frame sources per scene id."""
    value = _read_json(path)
    scenes = value.get("scenes")
    if not isinstance(scenes, dict):
        raise ValueError(f"Validation frame file must contain a scenes object: {path}")
    frames: dict[str, set[str]] = {}
    for scene_id, entry in scenes.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("frames"), list):
            raise ValueError(f"Validation frames for {scene_id} must contain a frames list")
        sources: set[str] = set()
        for frame in entry["frames"]:
            if not isinstance(frame, dict) or not isinstance(frame.get("source"), str) or not frame["source"]:
                raise ValueError(f"Validation frame for {scene_id} is missing source")
            identifier = frame.get("source_id")
            if identifier is None:
                scene_source = entry.get("source")
                if not isinstance(scene_source, str) or not scene_source:
                    raise ValueError(f"Validation scene {scene_id} is missing source")
                try:
                    identifier = Path(frame["source"]).relative_to(Path(scene_source)).as_posix()
                except ValueError as error:
                    raise ValueError(f"Validation frame for {scene_id} is outside its scene root") from error
            if not isinstance(identifier, str) or not identifier:
                raise ValueError(f"Validation frame for {scene_id} has invalid source_id")
            if identifier in sources:
                raise ValueError(f"Duplicate validation source ID for {scene_id}: {identifier}")
            sources.add(identifier)
        frames[str(scene_id)] = sources
    return frames


def disk_preflight(trial_root: Path, run_id: str, min_free_disk_bytes: int | None) -> dict[str, Any]:
    """Check the destination filesystem against the approved per-trial budget."""
    result: dict[str, Any] = {
        "run_id": run_id,
        "runs_root": str(trial_root),
        "required_bytes": min_free_disk_bytes,
        "free_bytes": None,
    }
    if not isinstance(min_free_disk_bytes, int) or isinstance(min_free_disk_bytes, bool) or min_free_disk_bytes <= 0:
        result["status"] = "invalid_budget"
        return result
    try:
        trial_root.mkdir(parents=True, exist_ok=True)
        result["free_bytes"] = shutil.disk_usage(trial_root).free
        result["status"] = "ok" if result["free_bytes"] >= min_free_disk_bytes else "insufficient_space"
    except OSError as error:
        result["status"] = "check_failed"
        result["error"] = f"{type(error).__name__}: {error}"
    return result


def run_dataset_benchmark(
    manifest_path: Path,
    candidates_path: Path,
    profiles: list[str],
    run_prefix: str,
    budget_hours: float,
    *,
    dry_run: bool = False,
    resume: bool = False,
    split: str = "calibration",
    repeat: int = 1,
    validation_frames: Path | None = None,
    record_hashes: bool = False,
    diagnostics: bool = False,
    runs_root: Path | None = None,
    min_free_disk_bytes: int | None = None,
) -> Path:
    """Plan or execute trials sequentially within an estimated wall-clock budget."""
    if budget_hours <= 0:
        raise ValueError("budget_hours must be positive")
    root = project_root()
    trial_root = runs_root.resolve() if runs_root is not None else root / "runs"
    output = root / "calibration" / run_prefix
    output.mkdir(parents=True, exist_ok=True)
    trials = build_trials(manifest_path, candidates_path, profiles, run_prefix, split=split, repeat=repeat)
    estimated_hours = sum(trial.estimated_minutes for trial in trials) / 60
    frames_path = validation_frames or root / DEFAULT_VALIDATION_FRAMES
    frozen: dict[str, set[str]] | None = None
    if frames_path.is_file():
        frozen = load_validation_frames(frames_path)
    elif record_hashes:
        raise FileNotFoundError(f"Frozen validation frames are required: {frames_path}")
    plan = {
        "schema_version": 1,
        "license_target": "academic-noncommercial",
        "budget_hours": budget_hours,
        "estimated_hours": round(estimated_hours, 2),
        "split": split,
        "repeat": repeat,
        "validation_frames": str(frames_path) if frozen is not None else None,
        "record_input_hashes": record_hashes,
        "runs_root": str(trial_root),
        "min_free_disk_bytes": min_free_disk_bytes,
        "input_files_sha256": {
            "manifest": sha256_file(manifest_path),
            "candidates": sha256_file(candidates_path),
            "validation_frames": sha256_file(frames_path) if frozen is not None else None,
        },
        "diagnostics": diagnostics,
        "trials": [trial.to_dict() for trial in trials],
        "locked_test_policy": "Run only the selected candidate after calibration review",
    }
    _write_json_atomic(output / "benchmark-plan.json", plan)
    if dry_run:
        return output

    missing_inputs = sorted({str(trial.input_path) for trial in trials if not trial.input_path.exists()})
    if missing_inputs:
        raise FileNotFoundError("Missing calibration inputs:\n" + "\n".join(missing_inputs))

    planned_hours = 0.0
    failures: list[dict[str, Any]] = []
    disk_preflights: list[dict[str, Any]] = []
    for trial in trials:
        metrics_path = trial_root / trial.run_id / "metrics.json"
        completed = _trial_metrics(metrics_path)
        if completed is not None:
            planned_hours += trial.estimated_minutes / 60
            continue
        incomplete = metrics_path.exists()
        if planned_hours + trial.estimated_minutes / 60 > budget_hours:
            failures.append({"run_id": trial.run_id, "reason": "budget"})
            break
        preflight = disk_preflight(trial_root, trial.run_id, min_free_disk_bytes)
        disk_preflights.append(preflight)
        _write_json_atomic(output / "disk-preflights.json", disk_preflights)
        if preflight["status"] != "ok":
            failures.append({"run_id": trial.run_id, "reason": "disk_preflight", **preflight})
            break
        planned_hours += trial.estimated_minutes / 60
        try:
            run_pipeline(
                trial.profile,
                trial.input_path,
                trial.run_id,
                resume=resume or incomplete,
                config_override=trial.config,
                output_dir=trial_root / trial.run_id,
                metadata={
                    "dataset_id": trial.dataset_id,
                    "scene_id": trial.scene_id,
                    "split": trial.split,
                    "candidate_id": trial.candidate_id,
                    "config_hash": _config_hash(trial.config),
                },
                record_hashes=record_hashes,
                diagnostics=diagnostics,
                validation_sources=frozen.get(trial.scene_id) if frozen is not None else None,
            )
        except Exception as error:  # One failed scene must not discard the remaining calibration matrix.
            failures.append({"run_id": trial.run_id, "error": f"{type(error).__name__}: {error}"})
        _write_json_atomic(output / "leaderboard.json", _leaderboard(trial_root, trials))
        _write_json_atomic(output / "failures.json", failures)
    _write_json_atomic(output / "leaderboard.json", _leaderboard(trial_root, trials))
    _write_json_atomic(output / "failures.json", failures)
    return output


if __name__ == "__main__":
    # Keep `python -m rescene.benchmark ...` working; it silently did nothing before.
    import sys

    from rescene.cli import main

    main(["benchmark", *sys.argv[1:]])
