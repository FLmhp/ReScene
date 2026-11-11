import json

import pytest

from rescene.job import run_job_spec


def test_run_job_rejects_missing_fields(tmp_path):
    spec = tmp_path / "job.json"
    spec.write_text(json.dumps({"job_id": "one"}), encoding="utf-8")
    with pytest.raises(ValueError, match="Missing job fields"):
        run_job_spec(spec, tmp_path / "output")


def test_run_job_rejects_unknown_profile(tmp_path):
    images = tmp_path / "images"
    images.mkdir()
    spec = tmp_path / "job.json"
    spec.write_text(
        json.dumps({"job_id": "one", "profile": "turbo", "input_dir": str(images)}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Unsupported profile"):
        run_job_spec(spec, tmp_path / "output")


def test_run_job_passes_single_video_to_pipeline(tmp_path, monkeypatch):
    video = tmp_path / "clip.mp4"
    video.touch()
    spec = tmp_path / "job.json"
    spec.write_text(json.dumps({"job_id": "one", "profile": "quality", "input_path": str(video)}))
    monkeypatch.setattr("rescene.job.run_pipeline", lambda _profile, path, _run_id, **_options: path)
    assert run_job_spec(spec, tmp_path / "output") == video
