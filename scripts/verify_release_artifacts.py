"""Verify completed jobs and the integrity of every published artifact."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

METRICS = ("registration_rate", "reprojection_error", "psnr", "ssim", "lpips", "total_seconds", "peak_vram_mb")
REQUIRED = {"metrics", "ply", "spz", "report", "manifest"}


class VerificationError(Exception):
    """A job or its deliverables failed verification."""


def parse_json(data: bytes, label: str) -> dict:
    """Parse a JSON object without accepting nonstandard numeric constants."""

    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid constant {value}")

    try:
        value = json.loads(data, parse_constant=reject_constant)
    except (ValueError, UnicodeDecodeError) as exc:
        raise VerificationError(f"{label}: invalid JSON") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{label}: expected a JSON object")
    return value


def artifact_index(manifest: dict, label: str, *, urls: bool) -> dict[str, dict]:
    """Validate and index artifact records from either manifest format."""
    version = manifest.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != 1:
        raise VerificationError(f"{label}: invalid version or artifacts list")
    if not isinstance(manifest.get("artifacts"), list):
        raise VerificationError(f"{label}: invalid version or artifacts list")
    result = {}
    for item in manifest["artifacts"]:
        if not isinstance(item, dict):
            raise VerificationError(f"{label}: invalid artifact record")
        kind, digest, size = item.get("kind"), item.get("sha256"), item.get("size")
        if not isinstance(kind, str) or not kind or kind in result:
            raise VerificationError(f"{label}: missing or duplicate artifact kind")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise VerificationError(f"{label}: {kind} has an invalid SHA-256")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise VerificationError(f"{label}: {kind} has an invalid size")
        if not isinstance(item.get("content_type"), str) or not item["content_type"]:
            raise VerificationError(f"{label}: {kind} has an invalid content type")
        if urls:
            url = item.get("url")
            try:
                parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
            except ValueError:
                parsed = None
            if parsed is None or parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise VerificationError(f"{label}: {kind} has an invalid URL")
        elif not isinstance(item.get("object_key"), str) or not item["object_key"]:
            raise VerificationError(f"{label}: {kind} has an invalid object key")
        result[kind] = item
    return result


def fetch_api(api_url: str, path: str, token: str | None) -> dict:
    """Fetch one API JSON object; never include credentials in diagnostics."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(api_url.rstrip("/") + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return parse_json(response.read(), "API response")
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
        raise VerificationError(f"API request failed for {path} ({type(exc).__name__})") from exc


def download_artifact(item: dict) -> bytes | None:
    """Stream and hash an artifact, retaining only the JSON inputs."""
    digest = hashlib.sha256()
    size = 0
    chunks = [] if item["kind"] in {"metrics", "manifest"} else None
    try:
        with urllib.request.urlopen(item["url"], timeout=60) as response:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
                if chunks is not None:
                    chunks.append(chunk)
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
        raise VerificationError(f"{item['kind']}: download failed ({type(exc).__name__})") from exc
    if size != item["size"]:
        raise VerificationError(f"{item['kind']}: size mismatch (expected {item['size']}, got {size})")
    if digest.hexdigest() != item["sha256"]:
        raise VerificationError(f"{item['kind']}: SHA-256 mismatch")
    return b"".join(chunks) if chunks is not None else None


def verify_job(api_url: str, token: str | None, project_id: str, job_id: str, max_peak_vram_mb: float | None) -> dict:
    """Verify a job, its manifests, all artifact bytes and required metrics."""
    job = fetch_api(api_url, f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}", token)
    if job.get("project_id") != project_id:
        raise VerificationError("job does not belong to the specified project")
    if job.get("status") != "SUCCEEDED":
        raise VerificationError(f"job status is {job.get('status')!r}, expected SUCCEEDED")
    reconstruction_id = job.get("reconstruction_id")
    if not isinstance(reconstruction_id, str) or not reconstruction_id:
        raise VerificationError("succeeded job has no reconstruction ID")
    path = f"/v1/reconstructions/{urllib.parse.quote(reconstruction_id, safe='')}/manifest"
    manifest = fetch_api(api_url, path, token)
    if manifest.get("reconstruction_id") != reconstruction_id:
        raise VerificationError("API manifest reconstruction ID does not match the job")
    artifacts = artifact_index(manifest, "API manifest", urls=True)
    missing = REQUIRED - artifacts.keys()
    if missing:
        raise VerificationError(f"missing required artifacts: {', '.join(sorted(missing))}")
    payloads = {kind: download_artifact(item) for kind, item in artifacts.items()}
    embedded = artifact_index(parse_json(payloads["manifest"], "artifact manifest"), "artifact manifest", urls=False)
    if embedded.keys() != artifacts.keys() - {"manifest"}:
        raise VerificationError("artifact manifest kinds do not match API manifest")
    for kind, item in embedded.items():
        for field in ("sha256", "size", "content_type"):
            if item[field] != artifacts[kind][field]:
                raise VerificationError(f"{kind}: manifest {field} mismatch")
    metrics = parse_json(payloads["metrics"], "metrics")
    for field in METRICS:
        value = metrics.get(field)
        try:
            valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
        except OverflowError:
            valid = False
        if not valid:
            raise VerificationError(f"metrics: {field} must be a finite number")
    if max_peak_vram_mb is not None and metrics["peak_vram_mb"] > max_peak_vram_mb:
        raise VerificationError(f"metrics: peak_vram_mb exceeds explicit limit {max_peak_vram_mb}")
    return {
        "job": job_id,
        "profile": job.get("profile"),
        "artifacts": sorted(artifacts),
        **{field: metrics[field] for field in METRICS},
    }


def main(argv: list[str] | None = None) -> int:
    """Run the verifier and return a failing exit status for any invalid job."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", required=True, help="API base URL")
    parser.add_argument("--token-file", type=Path, help="file containing a bearer token")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--max-peak-vram-mb", type=float, help="optional inclusive peak VRAM limit")
    parser.add_argument("jobs", nargs="+", help="job IDs")
    args = parser.parse_args(argv)
    parsed_url = urllib.parse.urlsplit(args.api_url)
    if (
        parsed_url.scheme not in {"http", "https"}
        or not parsed_url.netloc
        or parsed_url.username
        or parsed_url.password
    ):
        parser.error("--api-url must be an HTTP(S) URL without credentials")
    if args.max_peak_vram_mb is not None and (not math.isfinite(args.max_peak_vram_mb) or args.max_peak_vram_mb <= 0):
        parser.error("--max-peak-vram-mb must be a finite positive number")
    token = None
    if args.token_file:
        try:
            token = args.token_file.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            print("error: cannot read token file", file=sys.stderr)
            return 1
        if not token or "\n" in token or "\r" in token:
            print("error: token file must contain one nonempty token", file=sys.stderr)
            return 1
    failed = False
    for job_id in args.jobs:
        try:
            print(json.dumps(verify_job(args.api_url, token, args.project_id, job_id, args.max_peak_vram_mb)))
        except VerificationError as exc:
            print(f"job {job_id}: {exc}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
