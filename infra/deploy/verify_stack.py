"""Exercise login, STS, direct OSS upload, upload completion, and worker status."""

from __future__ import annotations

import base64
import hashlib
import json
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import oss2

API = "http://127.0.0.1:8000"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4x8AAAAASUVORK5CYII="
)


def request(method: str, path: str, body: dict[str, object] | None = None, token: str | None = None) -> object:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps(body).encode() if body is not None else None
    call = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(call, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path} failed with HTTP {error.code}: {error.read().decode()}") from error


password = Path("/run/secrets/admin_password").read_text(encoding="utf-8").strip()
login = request("POST", "/v1/auth/login", {"email": "admin@rescene.xyz", "password": password})
assert isinstance(login, dict)
token = str(login["access_token"])

project = request(
    "POST",
    "/v1/projects",
    {"name": f"Deployment verification {datetime.now(UTC).strftime('%Y-%m-%d')}"},
    token,
)
assert isinstance(project, dict)
project_id = str(project["id"])
digest = hashlib.sha256(PNG).hexdigest()
upload = request(
    "POST",
    f"/v1/projects/{project_id}/assets/upload-session",
    {"filename": "health.png", "size": len(PNG), "content_type": "image/png", "sha256": digest},
    token,
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
bucket.put_object(str(upload["object_key"]), PNG, headers={"Content-Type": "image/png"})
completed = request(
    "POST",
    f"/v1/assets/{upload['asset_id']}/complete",
    {"size": len(PNG), "sha256": digest},
    token,
)
workers = request("GET", "/v1/workers/status", token=token)

print(
    json.dumps(
        {
            "project_id": project_id,
            "asset_status": completed["status"],
            "worker_online": workers["online"],
            "worker_count": len(workers["workers"]),
        },
        sort_keys=True,
    )
)
