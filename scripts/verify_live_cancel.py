"""Verify cancellation of a disposable GPU Job in the deployed stack."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

import oss2
from verify_browser import admin_token

API = "https://api.rescene.xyz"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--job-id", help="Resume monitoring the existing acceptance job")
    source.add_argument("--video", type=Path, help="Local MP4 used to create a disposable acceptance job")
    args = parser.parse_args()
    video = args.video
    if video is not None and not video.is_file():
        parser.error("--video must point to an existing file")
    token = admin_token()

    def request(path: str, body: dict | None = None, *, retry: bool = False) -> dict:
        req = urllib.request.Request(
            API + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        attempts = 5 if retry or body is None else 1
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code < 500 or attempt == attempts - 1:
                    raise
            except OSError:
                if attempt == attempts - 1:
                    raise
            time.sleep(attempt + 1)
        raise AssertionError("Unreachable retry state")

    job = args.job_id
    if video is not None:
        data = video.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        project = request("/v1/projects", {"name": "Release V1 Cancellation Acceptance"})["id"]
        base = f"/v1/projects/{project}"
        upload = request(
            base + "/assets/upload-session",
            {
                "filename": video.name,
                "size": len(data),
                "content_type": "video/mp4",
                "sha256": digest,
            },
        )
        grant = upload["oss"]
        auth = oss2.StsAuth(grant["access_key_id"], grant["access_key_secret"], grant["security_token"])
        oss2.Bucket(auth, grant["endpoint"], grant["bucket"]).put_object(upload["object_key"], data)
        asset_id = upload["asset_id"]
        request(f"/v1/assets/{asset_id}/complete", {"size": len(data), "sha256": digest})
        job = request(base + "/jobs", {"asset_ids": [asset_id], "profile": "fast"})["id"]
        print(f"cancellation test queued: {job}", flush=True)
    endpoint = f"/v1/jobs/{job}"
    for _ in range(180):
        status = request(endpoint)
        if status["status"] == "RUNNING" and status["current_stage"] in {"geometry", "training"}:
            break
        assert status["status"] in {"QUEUED", "LEASED", "RUNNING"}, status["status"]
        time.sleep(5)
    else:
        raise TimeoutError("Test Job did not reach GPU execution")
    request(endpoint + "/cancel", {}, retry=True)
    for _ in range(24):
        status = request(endpoint)
        if status["status"] == "CANCELLED":
            assert status["reconstruction_id"] is None
            print(f"running job cancelled and never published: {job}", flush=True)
            return
        assert status["status"] == "RUNNING", status["status"]
        time.sleep(5)
    raise TimeoutError("The Worker did not finish cancellation")


if __name__ == "__main__":
    main()
