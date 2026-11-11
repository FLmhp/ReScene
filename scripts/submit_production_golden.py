"""Upload the bundled VGGT Kitchen scene and queue all production profiles."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import oss2

API = os.environ.get("RESCENE_API_URL", "https://api.rescene.xyz").rstrip("/")
TOKEN_FILE = Path(os.environ.get("RESCENE_ADMIN_TOKEN_FILE", "/root/ReScene/secrets/admin_access_token"))
TOKEN = sys.stdin.readline().strip() if "--token-stdin" in sys.argv else TOKEN_FILE.read_text().strip()
IMAGES = Path(
    os.environ.get(
        "RESCENE_GOLDEN_IMAGES",
        "/root/autodl-tmp/rescene/runtime/third_party/vggt/examples/kitchen/images",
    )
)
STATE = Path(os.environ.get("RESCENE_GOLDEN_STATE", "/root/autodl-tmp/rescene/state/production-golden-jobs.json"))


def request(method: str, path: str, body: dict[str, object] | None = None) -> object:
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    payload = json.dumps(body).encode() if body is not None else None
    call = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(call, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = error.read().decode()
            if error.code < 500 or attempt == 4:
                raise RuntimeError(f"{method} {path} failed with HTTP {error.code}: {body}") from error
        except urllib.error.URLError as error:
            if attempt == 4:
                raise RuntimeError(f"{method} {path} failed: {error.reason}") from error
        time.sleep(2**attempt)
    raise AssertionError("request retry loop exhausted")


video = os.environ.get("RESCENE_GOLDEN_VIDEO")
images = (
    [Path(video)]
    if video
    else sorted(path for path in IMAGES.iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png"})
)
if not video and len(images) < 8:
    raise SystemExit(f"Golden scene needs at least 8 images, found {len(images)} in {IMAGES}")

project_id = os.environ.get("RESCENE_GOLDEN_PROJECT_ID")
project = (
    request("GET", f"/v1/projects/{project_id}")
    if project_id
    else request(
        "POST",
        "/v1/projects",
        {"name": f"5090 Production Golden {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}"},
    )
)
assert isinstance(project, dict)
project_id = str(project["id"])
existing = {
    str(asset["filename"]): str(asset["id"])
    for asset in project.get("assets", [])
    if isinstance(asset, dict) and asset.get("status") == "READY"
}
asset_ids: list[str] = []
for index, image in enumerate(images, 1):
    if image.name in existing:
        asset_ids.append(existing[image.name])
        print(f"reused {index}/{len(images)} {image.name}", flush=True)
        continue
    data = image.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    content_type = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
    upload = request(
        "POST",
        f"/v1/projects/{project_id}/assets/upload-session",
        {"filename": image.name, "size": len(data), "content_type": content_type, "sha256": digest},
    )
    assert isinstance(upload, dict)
    grant = upload["oss"]
    assert isinstance(grant, dict)
    auth = oss2.StsAuth(
        str(grant["access_key_id"]),
        str(grant["access_key_secret"]),
        str(grant["security_token"]),
    )
    bucket = oss2.Bucket(auth, str(grant["endpoint"]), str(grant["bucket"]))
    bucket.put_object(str(upload["object_key"]), data, headers={"Content-Type": content_type})
    request(
        "POST",
        f"/v1/assets/{upload['asset_id']}/complete",
        {"size": len(data), "sha256": digest},
    )
    asset_ids.append(str(upload["asset_id"]))
    print(f"uploaded {index}/{len(images)} {image.name}", flush=True)

jobs: dict[str, str] = {}
for profile in os.environ.get("RESCENE_GOLDEN_PROFILES", "fast balanced quality").split():
    job = request(
        "POST",
        f"/v1/projects/{project_id}/jobs",
        {"profile": profile, "asset_ids": asset_ids},
    )
    assert isinstance(job, dict)
    jobs[profile] = str(job["id"])

STATE.write_text(json.dumps({"project_id": project_id, "jobs": jobs}, indent=2) + "\n", encoding="utf-8")
if "--token-stdin" not in sys.argv:
    TOKEN_FILE.unlink(missing_ok=True)
print(json.dumps({"project_id": project_id, "jobs": jobs}, sort_keys=True))
