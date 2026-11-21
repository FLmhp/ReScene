"""Generate and verify the golden API responses that the clients parse with Zod.

`tests/contracts/*.json` holds the exact response bodies produced by the FastAPI
app for the endpoints the shared API client consumes. The workspace job parses
each file with the corresponding zod schema (``scripts/check-api-contracts.mjs``)
and fails when the server shape drifts.

Run without arguments to rewrite the fixtures, or with ``--check`` to fail when
the committed files no longer match what the server produces.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "tests" / "contracts"
FIXTURE_TIME = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)

# The fixtures must not depend on the caller's environment, so pin every value
# that reaches a response. The database is a throwaway in-memory SQLite instance
# and the OSS credentials are inert placeholders.
FIXTURE_ENV = {
    "RESCENE_DATABASE_URL": "sqlite+pysqlite:///:memory:",
    "RESCENE_JWT_SECRET": "contract-fixture-secret-at-least-32-bytes",
    "RESCENE_WORKER_TOKEN": "contract-fixture-worker-token",
    "RESCENE_OSS_ENDPOINT": "https://oss.example.test",
    "RESCENE_OSS_REGION": "oss-cn-beijing",
    "RESCENE_OSS_BUCKET": "rescene-contracts",
    "RESCENE_OSS_ACCESS_KEY_ID": "contract-access-key-id",
    "RESCENE_OSS_ACCESS_KEY_SECRET": "contract-access-key-secret",
    "RESCENE_OSS_ROLE_ARN": "acs:ram::0000000000000000:role/contract-fixture",
    # Keep the uploading fixture asset from being reaped as stale.
    "RESCENE_STALE_UPLOAD_SECONDS": "315360000",
}
for _key, _value in FIXTURE_ENV.items():
    os.environ[_key] = _value
os.environ.pop("RESCENE_ADMIN_EMAIL", None)
os.environ.pop("RESCENE_ADMIN_PASSWORD_FILE", None)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

import rescene_api.main as api  # noqa: E402
import rescene_api.storage as storage_module  # noqa: E402
from rescene_api.auth import issue_token  # noqa: E402
from rescene_api.db import Base, engine  # noqa: E402
from rescene_api.models import (  # noqa: E402
    Asset,
    JobStage,
    Notification,
    Project,
    ProjectMember,
    Reconstruction,
    ReconstructionJob,
    Share,
    User,
)
from rescene_api.storage import TemporaryCredentials  # noqa: E402

OWNER_ID = "11111111-1111-4111-8111-111111111111"
VIEWER_ID = "11111111-1111-4111-8111-222222222222"
PROJECT_ID = "22222222-2222-4222-8222-222222222222"
COVER_ASSET_ID = "33333333-3333-4333-8333-333333333331"
SECOND_ASSET_ID = "33333333-3333-4333-8333-333333333332"
UPLOAD_ASSET_ID = "33333333-3333-4333-8333-333333333333"
RUNNING_JOB_ID = "44444444-4444-4444-8444-444444444441"
DONE_JOB_ID = "44444444-4444-4444-8444-444444444442"
RECONSTRUCTION_ID = "55555555-5555-4555-8555-555555555551"
SHARE_ID = "66666666-6666-4666-8666-666666666661"
CREATED_SHARE_ID = "66666666-6666-4666-8666-666666666662"
NOTIFICATION_ID = "77777777-7777-4777-8777-777777777771"
FIRST_STAGE_ID = "88888888-8888-4888-8888-888888888881"
SECOND_STAGE_ID = "88888888-8888-4888-8888-888888888882"

SEED_SHARE_TOKEN = "seed-share-token"
CREATED_SHARE_TOKEN = "created-share-token"


class FixtureStorage:
    """Deterministic stand-in for the OSS client; the fixtures never reach the network."""

    def upload_credentials(self, object_key: str, session_name: str) -> TemporaryCredentials:
        return TemporaryCredentials(
            access_key_id="STS.contract-access-key-id",
            access_key_secret="contract-access-key-secret",
            security_token="contract-security-token",
            expiration="2026-01-02T04:04:05Z",
        )


class FrozenDatetime(datetime):
    """Pin the clock used by the storage credential payload."""

    @classmethod
    def now(cls, tz: Any = None) -> datetime:
        return FIXTURE_TIME if tz else FIXTURE_TIME.replace(tzinfo=None)


def _seed() -> None:
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        owner = User(
            id=OWNER_ID,
            email="owner@example.com",
            password_hash="contract-fixture-password-hash",
            is_admin=False,
            active=True,
            created_at=FIXTURE_TIME,
        )
        viewer = User(
            id=VIEWER_ID,
            email="viewer@example.com",
            password_hash="contract-fixture-password-hash",
            is_admin=False,
            active=True,
            created_at=FIXTURE_TIME,
        )
        project = Project(
            id=PROJECT_ID,
            owner_id=OWNER_ID,
            name="Golden Scene",
            created_at=FIXTURE_TIME + timedelta(minutes=1),
        )
        assets = [
            Asset(
                id=COVER_ASSET_ID,
                project_id=PROJECT_ID,
                object_key=f"projects/{PROJECT_ID}/assets/{COVER_ASSET_ID}/original/frame-0001.jpg",
                filename="frame-0001.jpg",
                size=1024,
                content_type="image/jpeg",
                sha256="a" * 64,
                status="READY",
                created_at=FIXTURE_TIME + timedelta(minutes=2),
            ),
            Asset(
                id=SECOND_ASSET_ID,
                project_id=PROJECT_ID,
                object_key=f"projects/{PROJECT_ID}/assets/{SECOND_ASSET_ID}/original/frame-0002.jpg",
                filename="frame-0002.jpg",
                size=2048,
                content_type="image/jpeg",
                sha256="b" * 64,
                status="READY",
                created_at=FIXTURE_TIME + timedelta(minutes=3),
            ),
            Asset(
                id=UPLOAD_ASSET_ID,
                project_id=PROJECT_ID,
                object_key=f"projects/{PROJECT_ID}/assets/{UPLOAD_ASSET_ID}/original/clip.mp4",
                filename="clip.mp4",
                size=4096,
                content_type="video/mp4",
                sha256=None,
                status="UPLOADING",
                created_at=FIXTURE_TIME + timedelta(minutes=4),
            ),
        ]
        running_job = ReconstructionJob(
            id=RUNNING_JOB_ID,
            project_id=PROJECT_ID,
            profile="balanced",
            status="RUNNING",
            progress=0.42,
            current_stage="training",
            attempt=2,
            created_by=OWNER_ID,
            created_at=FIXTURE_TIME + timedelta(minutes=5),
            updated_at=FIXTURE_TIME + timedelta(minutes=6),
        )
        done_job = ReconstructionJob(
            id=DONE_JOB_ID,
            project_id=PROJECT_ID,
            profile="quality",
            status="SUCCEEDED",
            progress=1.0,
            current_stage=None,
            attempt=1,
            created_by=OWNER_ID,
            created_at=FIXTURE_TIME + timedelta(minutes=7),
            updated_at=FIXTURE_TIME + timedelta(minutes=8),
        )
        reconstruction = Reconstruction(
            id=RECONSTRUCTION_ID,
            project_id=PROJECT_ID,
            job_id=DONE_JOB_ID,
            version=1,
            created_at=FIXTURE_TIME + timedelta(minutes=9),
        )
        stages = [
            JobStage(
                id=FIRST_STAGE_ID,
                job_id=RUNNING_JOB_ID,
                stage="preprocess",
                status="success",
                progress=1.0,
                message=None,
                metrics={"images": 24},
                created_at=FIXTURE_TIME + timedelta(minutes=5),
            ),
            JobStage(
                id=SECOND_STAGE_ID,
                job_id=RUNNING_JOB_ID,
                stage="training",
                status="running",
                progress=0.42,
                message="Fitting gaussians",
                metrics={"psnr": 27.5, "step": 1200},
                created_at=FIXTURE_TIME + timedelta(minutes=6),
            ),
        ]
        share = Share(
            id=SHARE_ID,
            reconstruction_id=RECONSTRUCTION_ID,
            token_hash=hashlib.sha256(SEED_SHARE_TOKEN.encode()).hexdigest(),
            expires_at=FIXTURE_TIME + timedelta(days=7),
            revoked_at=None,
        )
        notification = Notification(
            id=NOTIFICATION_ID,
            user_id=OWNER_ID,
            kind="job.succeeded",
            title="Reconstruction finished",
            body="Golden Scene is ready to view.",
            project_id=PROJECT_ID,
            job_id=DONE_JOB_ID,
            announcement_id=None,
            read_at=None,
            created_at=FIXTURE_TIME + timedelta(minutes=10),
        )
        db.add_all(
            [
                owner,
                viewer,
                project,
                ProjectMember(project_id=PROJECT_ID, user_id=VIEWER_ID, role="viewer"),
                *assets,
                running_job,
                done_job,
                reconstruction,
                *stages,
                share,
                notification,
            ]
        )
        db.commit()


def _collection(client: TestClient, name: str, path: str, **kwargs: Any) -> Any:
    response = client.get(path, **kwargs)
    if response.status_code != 200:
        raise RuntimeError(f"{name}: GET {path} returned {response.status_code}: {response.text}")
    return response.json()


def _created_share(client: TestClient, headers: dict[str, str]) -> Any:
    original_token = api.secrets.token_urlsafe
    original_uuid4 = uuid.uuid4
    api.secrets.token_urlsafe = lambda _: CREATED_SHARE_TOKEN
    uuid.uuid4 = lambda: uuid.UUID(CREATED_SHARE_ID)
    try:
        response = client.post(f"/v1/reconstructions/{RECONSTRUCTION_ID}/shares", json={}, headers=headers)
        if response.status_code != 201:
            raise RuntimeError(f"POST shares returned {response.status_code}: {response.text}")
        return response.json()
    finally:
        api.secrets.token_urlsafe = original_token
        uuid.uuid4 = original_uuid4


def build_fixtures() -> dict[str, Any]:
    """Return every golden response keyed by its checked-in file name."""
    Base.metadata.drop_all(engine)
    _seed()
    storage_module.datetime = FrozenDatetime
    api.storage = lambda: FixtureStorage()
    headers = {"Authorization": f"Bearer {issue_token(OWNER_ID)}"}
    client = TestClient(api.app)
    project_path = f"/v1/projects/{PROJECT_ID}"
    return {
        "asset_page.json": _collection(
            client, "asset page", f"{project_path}/assets", params={"limit": 1}, headers=headers
        ),
        "auth_me.json": _collection(client, "auth me", "/v1/auth/me", headers=headers),
        "job.json": _collection(client, "job", f"/v1/jobs/{RUNNING_JOB_ID}", headers=headers),
        "job_page.json": _collection(client, "job page", f"{project_path}/jobs", params={"limit": 1}, headers=headers),
        "job_stages.json": _collection(client, "job stages", f"/v1/jobs/{RUNNING_JOB_ID}/stages", headers=headers),
        "notification_count.json": _collection(
            client, "notification count", "/v1/notifications/count", headers=headers
        ),
        "notifications.json": _collection(
            client, "notifications", "/v1/notifications", params={"limit": 50}, headers=headers
        ),
        "project_detail.json": _collection(client, "project detail", project_path, headers=headers),
        "project_summary.json": _collection(
            client, "project summary", project_path, params={"view": "summary"}, headers=headers
        ),
        "projects_list.json": _collection(client, "project list", "/v1/projects", headers=headers),
        "share.json": _created_share(client, headers),
        "shares.json": _collection(
            client, "shares", f"/v1/reconstructions/{RECONSTRUCTION_ID}/shares", headers=headers
        ),
        "upload_session.json": _upload_session(client, headers),
    }


def _upload_session(client: TestClient, headers: dict[str, str]) -> Any:
    response = client.post(f"/v1/assets/{UPLOAD_ASSET_ID}/upload-session", headers=headers)
    if response.status_code != 200:
        raise RuntimeError(f"POST upload-session returned {response.status_code}: {response.text}")
    return response.json()


def _serialize(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _mismatches(fixtures: dict[str, Any]) -> list[str]:
    failures = []
    expected_names = set(fixtures)
    present_names = {path.name for path in CONTRACTS.glob("*.json")}
    for name in sorted(expected_names | present_names):
        path = CONTRACTS / name
        if name not in fixtures:
            failures.append(f"{name}: committed fixture has no server response")
        elif name not in present_names:
            failures.append(f"{name}: committed fixture is missing")
        elif path.read_text(encoding="utf-8") != _serialize(fixtures[name]):
            failures.append(f"{name}: server response drifted from the committed fixture")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail instead of rewriting when fixtures differ")
    args = parser.parse_args(argv)
    fixtures = build_fixtures()
    if args.check:
        failures = _mismatches(fixtures)
        if failures:
            print("Contract fixtures are stale:", file=sys.stderr)
            for failure in failures:
                print(f"  {failure}", file=sys.stderr)
            print("Run `python scripts/generate_contract_fixtures.py` to refresh them.", file=sys.stderr)
            return 1
        print(f"Contract fixtures match the API responses ({len(fixtures)} files).")
        return 0
    CONTRACTS.mkdir(parents=True, exist_ok=True)
    for path in CONTRACTS.glob("*.json"):
        if path.name not in fixtures:
            path.unlink()
    for name, payload in fixtures.items():
        (CONTRACTS / name).write_text(_serialize(payload), encoding="utf-8", newline="\n")
    print(f"Wrote {len(fixtures)} contract fixtures to {CONTRACTS.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
