"""Stable file-based entry point used by remote workers."""

from __future__ import annotations

import json
from pathlib import Path

from rescene.pipeline import run_pipeline
from rescene.preprocess import classify_input


def run_job_spec(spec_path: Path, output_dir: Path, *, force_resume: bool = False) -> Path:
    """Run an image directory or a video from a Worker job spec."""
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    required = {"job_id", "profile"}
    missing = sorted(required - spec.keys())
    if not (spec.get("input_path") or spec.get("input_dir")):
        missing.append("input_path")
    if missing:
        raise ValueError(f"Missing job fields: {', '.join(missing)}")
    job_id = str(spec["job_id"])
    profile = str(spec["profile"])
    input_path = Path(str(spec.get("input_path") or spec["input_dir"])).resolve()
    if profile not in {"fast", "balanced", "quality"}:
        raise ValueError(f"Unsupported profile: {profile}")
    classify_input(input_path)
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return run_pipeline(
        profile,
        input_path,
        job_id,
        resume=force_resume or bool(spec.get("resume", False)),
        output_dir=output_dir,
        metadata={"job_id": job_id, "source": "worker"},
    )
