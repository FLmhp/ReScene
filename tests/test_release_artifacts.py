"""Behavioral coverage for release verification without network access."""

import hashlib
import io
import json
import urllib.parse

import pytest

from scripts import verify_release_artifacts as verifier


@pytest.fixture
def release(monkeypatch):
    metrics = dict.fromkeys(verifier.METRICS, 1.0)
    bodies = {
        "metrics": json.dumps(metrics).encode(),
        "ply": b"ply data",
        "spz": b"spz data",
        "report": b"report data",
    }
    records = []
    for kind, body in bodies.items():
        records.append(
            {
                "kind": kind,
                "object_key": f"artifacts/{kind}",
                "sha256": hashlib.sha256(body).hexdigest(),
                "size": len(body),
                "content_type": "application/octet-stream",
            }
        )
    bodies["manifest"] = json.dumps({"version": 1, "artifacts": records}).encode()
    manifest_record = {
        "kind": "manifest",
        "sha256": hashlib.sha256(bodies["manifest"]).hexdigest(),
        "size": len(bodies["manifest"]),
        "content_type": "application/json",
    }
    api_records = [
        {
            **{key: value for key, value in record.items() if key != "object_key"},
            "url": f"https://objects.invalid/{record['kind']}",
        }
        for record in [*records, manifest_record]
    ]
    job = {"project_id": "project", "status": "SUCCEEDED", "reconstruction_id": "recon", "profile": "FAST"}
    manifest = {"version": 1, "reconstruction_id": "recon", "artifacts": api_records}
    requests = []

    def open_url(request, timeout):
        url = request.full_url if hasattr(request, "full_url") else request
        path = urllib.parse.urlsplit(url).path
        requests.append(path)
        if path == "/v1/jobs/job":
            return io.BytesIO(json.dumps(job).encode())
        if path == "/v1/reconstructions/recon/manifest":
            return io.BytesIO(json.dumps(manifest).encode())
        kind = path.lstrip("/")
        if kind in bodies:
            return io.BytesIO(bodies[kind])
        raise AssertionError(f"unexpected request: {path}")

    monkeypatch.setattr(verifier.urllib.request, "urlopen", open_url)
    return job, manifest, bodies, requests


def run():
    return verifier.main(["--api-url", "https://api.invalid", "--project-id", "project", "job"])


def test_valid_release_checks_every_artifact(release, capsys):
    _, _, _, requests = release
    assert run() == 0
    assert set(requests) >= {"/metrics", "/ply", "/spz", "/report", "/manifest"}
    assert json.loads(capsys.readouterr().out)["job"] == "job"


def test_failed_job_is_failure(release, capsys):
    job, _, _, requests = release
    job["status"] = "FAILED"
    assert run() == 1
    assert "FAILED" in capsys.readouterr().err
    assert requests == ["/v1/jobs/job"]


def test_missing_artifact_is_failure(release, capsys):
    _, manifest, _, _ = release
    manifest["artifacts"] = [item for item in manifest["artifacts"] if item["kind"] != "ply"]
    assert run() == 1
    assert "missing required artifacts: ply" in capsys.readouterr().err


@pytest.mark.parametrize("kind", ["ply", "spz", "metrics", "report", "manifest"])
def test_hash_mismatch_is_failure(release, capsys, kind):
    _, _, bodies, _ = release
    bodies[kind] = bytes([bodies[kind][0] ^ 1]) + bodies[kind][1:]
    assert run() == 1
    assert f"{kind}: SHA-256 mismatch" in capsys.readouterr().err


def test_size_mismatch_is_failure(release, capsys):
    _, _, bodies, _ = release
    bodies["spz"] += b"extra"
    assert run() == 1
    assert "spz: size mismatch" in capsys.readouterr().err


@pytest.mark.parametrize("value", [None, "1", True, float("inf")])
def test_invalid_required_metric_is_failure(release, capsys, value):
    _, manifest, bodies, _ = release
    metrics = dict.fromkeys(verifier.METRICS, 1.0)
    metrics["psnr"] = value
    bodies["metrics"] = json.dumps(metrics).encode()
    embedded = json.loads(bodies["manifest"])
    for record in embedded["artifacts"]:
        if record["kind"] == "metrics":
            record["size"] = len(bodies["metrics"])
            record["sha256"] = hashlib.sha256(bodies["metrics"]).hexdigest()
    bodies["manifest"] = json.dumps(embedded).encode()
    for record in manifest["artifacts"]:
        if record["kind"] in {"metrics", "manifest"}:
            body = bodies[record["kind"]]
            record["size"] = len(body)
            record["sha256"] = hashlib.sha256(body).hexdigest()
    assert run() == 1
    assert "metrics" in capsys.readouterr().err


def test_invalid_metrics_are_rejected():
    with pytest.raises(verifier.VerificationError, match="invalid JSON"):
        verifier.parse_json(b'{"psnr": NaN}', "metrics")
