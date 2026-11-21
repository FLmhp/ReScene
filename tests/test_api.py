import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import oss2
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, select, update

from rescene_api import main
from rescene_api.auth import hash_password, issue_token, verify_password
from rescene_api.config import Settings
from rescene_api.db import SessionLocal, engine
from rescene_api.main import app
from rescene_api.models import (
    Asset,
    AssetCleanup,
    AuditLog,
    JobStage,
    Notification,
    Project,
    ProjectInvitation,
    ProjectMember,
    Reconstruction,
    ReconstructionJob,
    User,
    now,
)
from rescene_api.ratelimit import limiter
from rescene_api.schemas import ChangePasswordRequest
from rescene_api.storage import OssStorage, TemporaryCredentials


def test_login_project_and_worker_status(monkeypatch) -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="owner@example.com", password_hash=hash_password("correct-horse")))
            db.commit()

        login = client.post("/v1/auth/login", json={"email": "owner@example.com", "password": "correct-horse"})
        assert login.status_code == 200
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        created = client.post("/v1/projects", headers=headers, json={"name": "Golden Case"})
        assert created.status_code == 201
        assert client.get("/v1/projects", headers=headers).json()[0]["name"] == "Golden Case"
        assert client.get("/v1/workers/status", headers=headers).json() == {"online": False, "workers": []}
        with SessionLocal() as db:
            asset = Asset(
                project_id=created.json()["id"],
                object_key="projects/p/assets/a/original/image.jpg",
                filename="image.jpg",
                size=10,
                content_type="image/jpeg",
            )
            db.add(asset)
            db.commit()
        grant = TemporaryCredentials("id", "secret", "token", "later")
        monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(upload_credentials=lambda *_: grant))
        refreshed = client.post(f"/v1/assets/{asset.id}/upload-session", headers=headers)
        assert refreshed.status_code == 200
        assert refreshed.json()["object_key"] == asset.object_key


def test_projects_require_authentication() -> None:
    with TestClient(app) as client:
        assert client.get("/v1/projects").status_code == 401


def test_video_job_fencing_cancellation_and_session_revocation(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_WORKER_TOKEN", "worker-test-token")
    main.settings.cache_clear()
    grant = TemporaryCredentials("id", "secret", "token", "later")
    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(worker_credentials=lambda *_: grant))
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                db.add(User(email="queue@example.com", password_hash=hash_password("correct-horse")))
                db.add(User(email="isolated@example.com", password_hash=hash_password("correct-horse")))
                db.commit()
            login = client.post("/v1/auth/login", json={"email": "queue@example.com", "password": "correct-horse"})
            user = {"Authorization": f"Bearer {login.json()['access_token']}"}
            worker = {"Authorization": "Bearer worker-test-token", "X-Worker-Id": "test-worker"}
            project_id = client.post("/v1/projects", headers=user, json={"name": "Video"}).json()["id"]
            outsider = client.post(
                "/v1/auth/login", json={"email": "isolated@example.com", "password": "correct-horse"}
            )
            outsider_headers = {"Authorization": f"Bearer {outsider.json()['access_token']}"}
            assert client.get(f"/v1/projects/{project_id}", headers=outsider_headers).status_code == 403
            with SessionLocal() as db:
                video = Asset(
                    project_id=project_id,
                    object_key="video",
                    filename="clip.mp4",
                    size=10,
                    content_type="video/mp4",
                    status="READY",
                    sha256="a" * 64,
                )
                image = Asset(
                    project_id=project_id,
                    object_key="photo",
                    filename="photo.jpg",
                    size=10,
                    content_type="image/jpeg",
                    status="READY",
                )
                db.add_all([video, image])
                db.commit()
            route = f"/v1/projects/{project_id}/jobs"
            assert client.post(route, headers=user, json={"asset_ids": [video.id, image.id]}).status_code == 422
            job_id = client.post(route, headers=user, json={"asset_ids": [video.id]}).json()["id"]
            first = client.post("/v1/worker/lease", headers=worker).json()["job"]
            assert first["assets"][0]["sha256"] == "a" * 64
            assert first["attempt"] == 1
            assert client.post("/v1/worker/lease", headers=worker).json()["job"] is None
            with SessionLocal() as db:
                db.get(ReconstructionJob, job_id).lease_expires_at = now() - timedelta(seconds=1)
                db.commit()
            second = client.post("/v1/worker/lease", headers=worker).json()["job"]
            assert second["job_id"] == job_id and second["attempt"] == 2
            endpoint = f"/v1/worker/jobs/{job_id}"
            for attempt, expected in [("1", 409), ("2", 200)]:
                response = client.post(
                    f"{endpoint}/heartbeat", headers={**worker, "X-Lease-Attempt": attempt}, json={"progress": 0}
                )
                assert response.status_code == expected
            assert client.post(f"/v1/jobs/{job_id}/cancel", headers=user).status_code == 200
            failure = client.post(
                f"{endpoint}/fail",
                headers={**worker, "X-Lease-Attempt": "2"},
                json={"error_code": "CANCELLED", "error_message": "cancelled"},
            )
            assert failure.json()["status"] == "CANCELLED"
            assert client.post(f"/v1/jobs/{job_id}/retry", headers=user).status_code == 200
            third = client.post("/v1/worker/lease", headers=worker).json()["job"]
            assert third["attempt"] == 3
            completion = {
                "artifacts": [
                    {
                        "kind": kind,
                        "object_key": f"{third['output_prefix']}artifacts/{kind}/result",
                        "sha256": "a" * 64,
                        "size": 10,
                        "content_type": "application/octet-stream",
                    }
                    for kind in ("spz", "ply", "metrics", "report")
                ]
            }
            attempt_headers = {**worker, "X-Lease-Attempt": "3"}
            with SessionLocal() as db:
                db.get(ReconstructionJob, job_id).error_code = "WORKER_LEASE_EXPIRED"
                db.commit()
            first_completion = client.post(f"{endpoint}/complete", headers=attempt_headers, json=completion)
            replay = client.post(f"{endpoint}/complete", headers=attempt_headers, json=completion)
            assert first_completion.status_code == replay.status_code == 200
            assert first_completion.json() == replay.json()
            with SessionLocal() as db:
                recovered = db.get(ReconstructionJob, job_id)
                assert recovered.error_code is None
                recovered.error_code = "WORKER_LEASE_EXPIRED"
                recovered.error_message = "Worker heartbeat expired"
                db.commit()
            recovered_view = client.get(f"/v1/jobs/{job_id}", headers=user).json()
            assert recovered_view["status"] == "SUCCEEDED"
            assert recovered_view["error_code"] is None and recovered_view["error_message"] is None
            completion["artifacts"][0]["sha256"] = "b" * 64
            assert client.post(f"{endpoint}/complete", headers=attempt_headers, json=completion).status_code == 409
            assert client.post("/v1/auth/logout", headers=user).status_code == 204
            assert client.get("/v1/projects", headers=user).status_code == 401
    finally:
        main.settings.cache_clear()


def test_post_object_policy_is_bound_to_one_key() -> None:
    config = Settings(
        database_url="sqlite://",
        jwt_secret="test-secret-that-is-at-least-32-bytes",
        jwt_ttl_minutes=60,
        worker_token="worker",
        cors_origins=(),
        admin_email=None,
        admin_password_file=None,
        oss_endpoint="oss-cn-beijing.aliyuncs.com",
        oss_region="oss-cn-beijing",
        oss_bucket="rescene-test",
        oss_access_key_id="access-id",
        oss_access_key_secret="access-secret",
        oss_role_arn="acs:ram::1:role/rescene",
    )
    backend = OssStorage(config)

    credentials = TemporaryCredentials(
        access_key_id="STS.access-id",
        access_key_secret="temporary-secret",
        security_token="security-token",
        expiration="2026-11-10T06:00:00Z",
    )

    fields = backend.post_fields("projects/p/assets/a/original/kitchen.jpg", 4096, credentials)

    policy = json.loads(base64.b64decode(fields["policy"]))
    assert ["eq", "$key", "projects/p/assets/a/original/kitchen.jpg"] in policy["conditions"]
    assert ["content-length-range", 1, 4096] in policy["conditions"]
    signature = base64.b64encode(hmac.new(b"temporary-secret", fields["policy"].encode(), hashlib.sha1).digest())
    assert fields["signature"] == signature.decode()
    assert fields["OSSAccessKeyId"] == "STS.access-id"
    assert fields["x-oss-security-token"] == "security-token"
    assert backend.post_target() == "https://rescene-test.oss-cn-beijing.aliyuncs.com"


def test_post_upload_session_targets_the_mini_program_flow(monkeypatch) -> None:
    monkeypatch.setattr(
        main,
        "storage",
        lambda: SimpleNamespace(
            post_target=lambda: "https://rescene-test.oss-cn-beijing.aliyuncs.com",
            upload_credentials=lambda key, session: TemporaryCredentials(
                access_key_id="STS.access-id",
                access_key_secret="temporary-secret",
                security_token="security-token",
                expiration="2026-11-10T06:00:00Z",
            ),
            post_fields=lambda key, size, credentials: {
                "key": key,
                "policy": "signed",
                "x-oss-security-token": credentials.security_token,
                "success_action_status": "200",
            },
        ),
    )
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="mini@example.com", password_hash=hash_password("correct-horse")))
            db.commit()
        login = client.post("/v1/auth/login", json={"email": "mini@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Mini"}).json()["id"]
        route = f"/v1/projects/{project_id}/assets/upload-session"
        payload = {
            "filename": "kitchen.jpg",
            "size": 2048,
            "content_type": "image/jpeg",
            "sha256": "a" * 64,
            "mode": "post",
        }

        created = client.post(route, headers=headers, json=payload)

        assert created.status_code == 201
        grant = created.json()
        assert grant["mode"] == "post"
        assert grant["url"].startswith("https://")
        assert grant["fields"]["key"] == grant["object_key"]
        assert grant["fields"]["x-oss-security-token"] == "security-token"
        refreshed = client.post(f"/v1/assets/{grant['asset_id']}/upload-session?mode=post", headers=headers)
        assert refreshed.status_code == 200
        assert refreshed.json()["mode"] == "post"
        assert client.post(route, headers=headers, json={**payload, "size": 6 * 1024**3}).status_code == 422


def test_registration_normalizes_email_and_signs_in() -> None:
    with TestClient(app) as client:
        created = client.post("/v1/auth/register", json={"email": " New@Example.com ", "password": "correct-horse"})
        assert created.status_code == 201
        headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
        assert client.get("/v1/auth/me", headers=headers).json()["email"] == "new@example.com"
        duplicate = client.post("/v1/auth/register", json={"email": "new@example.com", "password": "correct-horse"})
        assert duplicate.status_code == 409
        login = client.post("/v1/auth/login", json={"email": "new@example.com", "password": "correct-horse"})
        assert login.status_code == 200
    with SessionLocal() as db:
        assert db.query(User).filter(User.email == "new@example.com").count() == 1


def test_registration_rejects_invalid_input() -> None:
    with TestClient(app) as client:
        short = client.post("/v1/auth/register", json={"email": "short@example.com", "password": "short"})
        assert short.status_code == 422
        malformed = client.post("/v1/auth/register", json={"email": "not-an-email", "password": "correct-horse"})
        assert malformed.status_code == 422
    with SessionLocal() as db:
        assert db.query(User).count() == 0


class RecordingStore:
    """Stands in for OSS so deletion is observable without network calls."""

    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.errors: dict[str, Exception] = {}

    def upload_credentials(self, key: str, session: str) -> TemporaryCredentials:
        return TemporaryCredentials("id", "secret", "token", "later")

    def delete(self, key: str) -> None:
        if key in self.errors:
            raise self.errors[key]
        self.deleted.append(key)


def test_asset_delete_and_stale_upload_expiry(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app) as client:
        created = client.post("/v1/auth/register", json={"email": "cleaner@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Storage"}).json()["id"]
        session = client.post(
            f"/v1/projects/{project_id}/assets/upload-session",
            headers=headers,
            json={"filename": "frame.jpg", "size": 2048, "content_type": "image/jpeg", "sha256": "a" * 64},
        )
        assert session.status_code == 201
        grant = session.json()
        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 204
        assert store.deleted == []
        assert client.get(f"/v1/projects/{project_id}", headers=headers).json()["assets"] == []
        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 404
        assert main.reap_once() is None
        assert store.deleted == [grant["object_key"]]
        with SessionLocal() as db:
            assert db.scalars(select(AssetCleanup)).all() == []

        with SessionLocal() as db:
            stale = Asset(
                project_id=project_id,
                object_key="projects/p/assets/stale/original/old.jpg",
                filename="old.jpg",
                size=10,
                content_type="image/jpeg",
                created_at=now() - timedelta(hours=2),
            )
            ready = Asset(
                project_id=project_id,
                object_key="projects/p/assets/ready/original/frame.jpg",
                filename="frame.jpg",
                size=10,
                content_type="image/jpeg",
                status="READY",
                sha256="b" * 64,
            )
            db.add_all([stale, ready])
            db.commit()
            ready_id = ready.id
            stale_id, stale_key = stale.id, stale.object_key
        store.errors[stale_key] = oss2.exceptions.NoSuchKey(404, {}, "", {"Code": "NoSuchKey"})
        monkeypatch.setenv("RESCENE_STALE_UPLOAD_SECONDS", "60")
        main.settings.cache_clear()
        detail = client.get(f"/v1/projects/{project_id}", headers=headers).json()
        assert [item["filename"] for item in detail["assets"]] == ["frame.jpg"]
        assert store.deleted == [grant["object_key"]]
        with SessionLocal() as db:
            assert db.get(Asset, stale_id) is None
            assert db.scalar(select(AuditLog).where(AuditLog.target_id == stale_id)).action == "asset.expire"
            queued = db.scalars(select(AssetCleanup)).all()
            assert [(row.object_key, row.reason) for row in queued] == [(stale_key, "asset.expire")]
        assert main.reap_once() is None
        with SessionLocal() as db:
            assert db.scalars(select(AssetCleanup)).all() == []

        job = client.post(f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [ready_id]})
        assert job.status_code == 201
        refused = client.delete(f"/v1/assets/{ready_id}", headers=headers)
        assert refused.status_code == 409
        assert refused.headers["x-error-code"] == "asset.in_use"


def test_stale_upload_expiry_queues_bytes_for_the_reaper(monkeypatch) -> None:
    store = RecordingStore()

    def unavailable_storage():
        raise HTTPException(503, "OSS is not configured")

    with TestClient(app) as client:
        with SessionLocal() as db:
            owner = User(email="cleanup-owner@example.com", password_hash=hash_password("correct-horse"))
            outsider = User(email="cleanup-outsider@example.com", password_hash=owner.password_hash)
            db.add_all([owner, outsider])
            db.commit()
        headers = {"Authorization": f"Bearer {issue_token(owner.id)}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Upload cleanup"}).json()["id"]
        route = f"/v1/projects/{project_id}/assets"
        detail_route = f"/v1/projects/{project_id}"
        old = now() - timedelta(days=2)
        with SessionLocal() as db:
            assets = {
                key: Asset(
                    project_id=project_id,
                    object_key=f"cleanup/{key}",
                    filename=f"{key}.jpg",
                    size=10,
                    content_type="image/jpeg",
                    status=asset_status,
                    created_at=created_at,
                )
                for key, asset_status, created_at in (
                    ("retry", "UPLOADING", old),
                    ("expired", "UPLOADING", old),
                    ("ready", "READY", old),
                    ("young", "UPLOADING", now()),
                )
            }
            db.add_all(assets.values())
            db.commit()
        monkeypatch.setattr(main, "storage", lambda: store)
        assert client.get(route).status_code == 401
        assert client.get(route, headers={"Authorization": f"Bearer {issue_token(outsider.id)}"}).status_code == 403
        assert client.get(f"{detail_route}?view=summary", headers=headers).json()["asset_count"] == 4
        assert store.deleted == []

        # Expiry is a database-only step now: storage being down neither blocks
        # the listing nor leaves the abandoned rows behind.
        monkeypatch.setattr(main, "storage", unavailable_storage)
        unavailable = client.get(route, headers=headers)
        assert unavailable.status_code == 200
        remaining = {assets[key].id for key in ("ready", "young")}
        assert {item["id"] for item in unavailable.json()["items"]} == remaining
        with SessionLocal() as db:
            assert sorted(
                db.scalars(select(AuditLog.target_id).where(AuditLog.action == "asset.expire")).all()
            ) == sorted([assets["expired"].id, assets["retry"].id])
            queued = db.scalars(select(AssetCleanup)).all()
            assert sorted(row.object_key for row in queued) == sorted(
                [assets["expired"].object_key, assets["retry"].object_key]
            )

        # The reaper applies backoff per record instead of retrying every GET.
        monkeypatch.setattr(main, "storage", lambda: store)
        store.errors[assets["expired"].object_key] = oss2.exceptions.OssError(503, {}, "ServiceUnavailable", {})
        store.errors[assets["retry"].object_key] = oss2.exceptions.RequestError(TimeoutError())
        assert main.reap_asset_cleanups() == 0
        assert main.reap_asset_cleanups() == 0
        assert store.deleted == []
        with SessionLocal() as db:
            records = db.scalars(select(AssetCleanup)).all()
            assert len(records) == 2
            assert {record.attempts for record in records} == {1}
            assert all(record.next_attempt_at.replace(tzinfo=UTC) > now() + timedelta(seconds=60) for record in records)
            for record in records:
                record.next_attempt_at = now() - timedelta(seconds=1)
            db.commit()

        store.errors.clear()
        detail = client.get(detail_route, headers=headers)
        assert detail.status_code == 200
        assert {item["id"] for item in detail.json()["assets"]} == remaining
        assert main.reap_asset_cleanups() == 2
        assert sorted(store.deleted) == sorted([assets["expired"].object_key, assets["retry"].object_key])
        with SessionLocal() as db:
            assert db.scalars(select(AssetCleanup)).all() == []
            assert db.get(Asset, assets["retry"].id) is None


def register_asset(client, email: str) -> tuple[dict[str, str], str, dict[str, object]]:
    created = client.post("/v1/auth/register", json={"email": email, "password": "correct-horse"})
    headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
    project_id = client.post("/v1/projects", headers=headers, json={"name": "Cleanup queue"}).json()["id"]
    session = client.post(
        f"/v1/projects/{project_id}/assets/upload-session",
        headers=headers,
        json={"filename": "frame.jpg", "size": 2048, "content_type": "image/jpeg", "sha256": "a" * 64},
    )
    assert session.status_code == 201
    return headers, project_id, session.json()


def test_asset_delete_keeps_the_row_and_bytes_when_the_commit_fails(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app, raise_server_exceptions=False) as client:
        headers, project_id, grant = register_asset(client, "conflict@example.com")
        with SessionLocal() as db:
            db.add(AssetCleanup(object_key=str(grant["object_key"]), reason="asset.delete", next_attempt_at=now()))
            db.commit()

        failed = client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers)
        assert failed.status_code == 500
        assert store.deleted == []
        detail = client.get(f"/v1/projects/{project_id}", headers=headers).json()
        assert [item["id"] for item in detail["assets"]] == [grant["asset_id"]]
        with SessionLocal() as db:
            assert db.get(Asset, str(grant["asset_id"])) is not None
            assert db.get(Asset, str(grant["asset_id"])).status == "UPLOADING"
            assert db.scalars(select(AuditLog).where(AuditLog.action == "asset.delete")).all() == []
            db.delete(db.scalar(select(AssetCleanup)))
            db.commit()

        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 204
        assert store.deleted == []
        main.reap_once()
        assert store.deleted == [grant["object_key"]]


def test_cleanup_queue_retries_transient_failures_with_backoff(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app) as client:
        headers, project_id, grant = register_asset(client, "backoff@example.com")
        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 204
        with SessionLocal() as db:
            record = db.scalar(select(AssetCleanup))
            assert record is not None and record.object_key == grant["object_key"] and record.attempts == 0
            store.errors[str(grant["object_key"])] = oss2.exceptions.OssError(503, {}, "ServiceUnavailable", {})

        assert main.reap_asset_cleanups() == 0
        with SessionLocal() as db:
            record = db.scalar(select(AssetCleanup))
            assert record is not None
            assert record.attempts == 1
            assert record.last_error is not None and "OssError" in record.last_error
            assert record.next_attempt_at.replace(tzinfo=UTC) > now() + timedelta(seconds=60)
            record.next_attempt_at = now() - timedelta(seconds=1)
            db.commit()

        store.errors.clear()
        assert main.reap_asset_cleanups() == 1
        assert store.deleted == [grant["object_key"]]
        with SessionLocal() as db:
            assert db.scalars(select(AssetCleanup)).all() == []


def test_cleanup_queue_treats_a_missing_object_as_done(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app) as client:
        headers, _, grant = register_asset(client, "missing-object@example.com")
        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 204
        with SessionLocal() as db:
            store.errors[str(grant["object_key"])] = oss2.exceptions.NoSuchKey(404, {}, "", {"Code": "NoSuchKey"})

        assert main.reap_asset_cleanups() == 1
        assert store.deleted == []
        with SessionLocal() as db:
            assert db.scalars(select(AssetCleanup)).all() == []


def ready_asset(project_id: str, name: str = "frame.jpg") -> str:
    with SessionLocal() as db:
        asset = Asset(
            project_id=project_id,
            object_key=f"idempotent/{name}",
            filename=name,
            size=10,
            content_type="image/jpeg",
            status="READY",
            sha256="a" * 64,
        )
        db.add(asset)
        db.commit()
        return asset.id


def test_job_creation_replays_the_first_response_for_a_repeated_key() -> None:
    with TestClient(app) as client:
        created = client.post("/v1/auth/register", json={"email": "retry@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Retry"}).json()["id"]
        asset_id = ready_asset(project_id)
        keyed = {**headers, "Idempotency-Key": "job-retry-1"}
        body = {"profile": "balanced", "asset_ids": [asset_id]}

        first = client.post(f"/v1/projects/{project_id}/jobs", headers=keyed, json=body)
        second = client.post(f"/v1/projects/{project_id}/jobs", headers=keyed, json=body)
        assert first.status_code == 201 and second.status_code == 201
        assert second.json() == first.json()
        with SessionLocal() as db:
            assert len(db.scalars(select(ReconstructionJob)).all()) == 1
            assert len(db.scalars(select(AuditLog).where(AuditLog.action == "job.create")).all()) == 1

        conflict = client.post(
            f"/v1/projects/{project_id}/jobs", headers=keyed, json={"profile": "fast", "asset_ids": [asset_id]}
        )
        assert conflict.status_code == 409
        assert conflict.headers["x-error-code"] == "idempotency.conflict"
        with SessionLocal() as db:
            assert len(db.scalars(select(ReconstructionJob)).all()) == 1

        new_key = {**headers, "Idempotency-Key": "job-retry-2"}
        again = client.post(f"/v1/projects/{project_id}/jobs", headers=new_key, json=body)
        assert again.status_code == 201 and again.json()["id"] != first.json()["id"], "a new key starts a new operation"


def test_project_creation_replays_only_for_the_same_key() -> None:
    with TestClient(app) as client:
        created = client.post("/v1/auth/register", json={"email": "projects@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
        keyed = {**headers, "Idempotency-Key": "project-retry-1"}

        first = client.post("/v1/projects", headers=keyed, json={"name": "Studio"})
        second = client.post("/v1/projects", headers=keyed, json={"name": "Studio"})
        assert first.status_code == 201 and second.status_code == 201
        assert second.json() == first.json()

        plain = client.post("/v1/projects", headers=headers, json={"name": "Studio"})
        other = client.post("/v1/projects", headers=headers, json={"name": "Studio"})
        assert plain.json()["id"] != other.json()["id"], "requests without a key keep creating new projects"
        assert len({first.json()["id"], plain.json()["id"], other.json()["id"]}) == 3

        too_long = client.post("/v1/projects", headers={**headers, "Idempotency-Key": "x" * 129}, json={"name": "Long"})
        assert too_long.status_code == 400
        assert too_long.headers["x-error-code"] == "idempotency.invalid_key"


def test_idempotency_keys_are_scoped_to_the_account_and_project() -> None:
    with TestClient(app) as client:
        first = client.post("/v1/auth/register", json={"email": "one@example.com", "password": "correct-horse"})
        second = client.post("/v1/auth/register", json={"email": "two@example.com", "password": "correct-horse"})
        one = {"Authorization": f"Bearer {first.json()['access_token']}", "Idempotency-Key": "shared-key"}
        two = {"Authorization": f"Bearer {second.json()['access_token']}", "Idempotency-Key": "shared-key"}
        mine = client.post("/v1/projects", headers=one, json={"name": "Mine"}).json()
        theirs = client.post("/v1/projects", headers=two, json={"name": "Theirs"})
        assert theirs.status_code == 201 and theirs.json()["id"] != mine["id"]

        second_project = {**one, "Idempotency-Key": "shared-key-2"}
        other_project = client.post("/v1/projects", headers=second_project, json={"name": "Second"}).json()["id"]
        asset_a = ready_asset(mine["id"], "a.jpg")
        asset_b = ready_asset(other_project, "b.jpg")
        headers_a = {**one, "Idempotency-Key": "job-shared"}
        job_a = client.post(f"/v1/projects/{mine['id']}/jobs", headers=headers_a, json={"asset_ids": [asset_a]})
        job_b = client.post(f"/v1/projects/{other_project}/jobs", headers=headers_a, json={"asset_ids": [asset_b]})
        assert job_a.status_code == 201 and job_b.status_code == 201
        assert job_a.json()["id"] != job_b.json()["id"], "the project scopes the key"


def test_password_change_revokes_other_sessions() -> None:
    with TestClient(app) as client:
        created = client.post("/v1/auth/register", json={"email": "rotate@example.com", "password": "correct-horse"})
        old = {"Authorization": f"Bearer {created.json()['access_token']}"}
        wrong = client.post(
            "/v1/auth/password",
            headers=old,
            json={"current_password": "not-the-password", "new_password": "correct-horse-2"},
        )
        assert wrong.status_code == 400
        assert wrong.headers["x-error-code"] == "auth.password_mismatch"
        rotated = client.post(
            "/v1/auth/password",
            headers=old,
            json={"current_password": "correct-horse", "new_password": "correct-horse-2"},
        )
        assert rotated.status_code == 200
        fresh = {"Authorization": f"Bearer {rotated.json()['access_token']}"}
        assert client.get("/v1/auth/me", headers=old).status_code == 401
        assert client.get("/v1/auth/me", headers=fresh).status_code == 200
        assert (
            client.post("/v1/auth/login", json={"email": "rotate@example.com", "password": "correct-horse"}).status_code
            == 401
        )
        login = client.post("/v1/auth/login", json={"email": "rotate@example.com", "password": "correct-horse-2"})
        assert login.status_code == 200


def test_password_change_rejects_a_stale_verified_hash() -> None:
    with TestClient(app) as client:
        assert (
            client.post(
                "/v1/auth/register", json={"email": "race@example.com", "password": "correct-horse"}
            ).status_code
            == 201
        )
        with SessionLocal() as db:
            user_id = db.scalar(select(User.id).where(User.email == "race@example.com"))
        with SessionLocal() as stale, SessionLocal() as fresher:
            user = stale.get(User, user_id)
            fresher.execute(update(User).where(User.id == user_id).values(password_hash=hash_password("someone-else")))
            fresher.commit()
            with pytest.raises(HTTPException) as raised:
                main.change_password(
                    ChangePasswordRequest(current_password="correct-horse", new_password="correct-horse-2"),
                    stale,
                    user,
                )
        assert raised.value.status_code == 409
        assert raised.value.headers["X-Error-Code"] == "auth.session_stale"
        with SessionLocal() as db:
            current = db.get(User, user_id)
            assert verify_password("someone-else", current.password_hash)
            assert current.token_version == 0, "a refused rotation must not advance the version"


def test_session_version_grows_with_every_revocation() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True))
            db.add(User(email="member@example.com", password_hash=hash_password("correct-horse")))
            db.commit()
        with SessionLocal() as db:
            member_id = db.scalar(select(User.id).where(User.email == "member@example.com"))

        def bearer(email: str) -> dict[str, str]:
            token = client.post("/v1/auth/login", json={"email": email, "password": "correct-horse"}).json()[
                "access_token"
            ]
            return {"Authorization": f"Bearer {token}"}

        admin = bearer("root@example.com")
        member = bearer("member@example.com")

        def version() -> int:
            with SessionLocal() as db:
                return db.get(User, member_id).token_version

        start = version()
        assert client.post("/v1/auth/logout", headers=member).status_code == 204
        after_logout = version()
        assert after_logout > start
        assert (
            client.post(
                f"/v1/users/{member_id}/password", headers=admin, json={"password": "reset-password"}
            ).status_code
            == 204
        )
        after_reset = version()
        assert after_reset > after_logout
        assert client.patch(f"/v1/users/{member_id}", headers=admin, json={"active": False}).status_code == 200
        after_deactivate = version()
        assert after_deactivate > after_reset
        assert client.get("/v1/auth/me", headers=member).status_code == 401


def test_project_list_resolves_roles_in_one_batch() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            owner = User(email="owner@example.com", password_hash=hash_password("correct-horse"))
            member = User(email="member@example.com", password_hash=hash_password("correct-horse"))
            db.add_all([owner, member])
            db.flush()
            owned = Project(name="Owned", owner_id=member.id)
            db.add(owned)
            for index in range(4):
                project = Project(name=f"Shared {index}", owner_id=owner.id)
                db.add(project)
                db.flush()
                db.add(ProjectMember(project_id=project.id, user_id=member.id, role="member"))
            hidden = Project(name="Hidden", owner_id=owner.id)
            deleted = Project(name="Deleted", owner_id=owner.id, deleted_at=now())
            db.add_all([hidden, deleted])
            db.commit()
            member_id = member.id
        headers = {
            "Authorization": f"Bearer {client.post('/v1/auth/login', json={'email': 'member@example.com', 'password': 'correct-horse'}).json()['access_token']}"
        }

        def count_queries() -> tuple[int, list[str]]:
            statements: list[str] = []

            def record(_conn, _cursor, statement, _parameters, _context, _executemany):
                statements.append(statement)

            event.listen(engine, "before_cursor_execute", record)
            try:
                response = client.get("/v1/projects", headers=headers)
            finally:
                event.remove(engine, "before_cursor_execute", record)
            assert response.status_code == 200
            return len(statements), [statement.lower() for statement in statements]

        with_many, statements = count_queries()
        projects = client.get("/v1/projects", headers=headers).json()
        assert {item["name"] for item in projects} == {"Owned", "Shared 0", "Shared 1", "Shared 2", "Shared 3"}
        assert [item["created_at"] for item in projects] == sorted(
            (item["created_at"] for item in projects), reverse=True
        )
        assert {item["effective_role"] for item in projects} == {"owner", "member"}

        with SessionLocal() as db:
            db.execute(delete(ProjectMember).where(ProjectMember.user_id == member_id))
            db.commit()
        with_fewer, _ = count_queries()
        assert with_fewer == with_many, "the list query count must not grow with collaborations"
        assert sum("project_members" in statement for statement in statements) == 2, (
            "one membership filter plus one batched role projection"
        )

        assert [item["name"] for item in client.get("/v1/projects", headers=headers).json()] == ["Owned"]


def test_project_summary_list_has_bounded_query_count() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            owner = User(email="library@example.com", password_hash=hash_password("correct-horse"))
            db.add(owner)
            db.flush()
            for index in range(20):
                project = Project(name=f"Library {index:02d}", owner_id=owner.id)
                db.add(project)
                db.flush()
                db.add_all(
                    [
                        Asset(
                            project_id=project.id,
                            object_key=f"library/{index}/{asset_index}",
                            filename=f"frame-{asset_index}.jpg",
                            content_type="image/jpeg",
                            size=10,
                            status="READY",
                        )
                        for asset_index in range(3)
                    ]
                )
                db.add_all(
                    [
                        ReconstructionJob(
                            project_id=project.id,
                            profile="fast",
                            status="RUNNING" if index % 2 else "SUCCEEDED",
                        ),
                        ReconstructionJob(project_id=project.id, profile="balanced", status="SUCCEEDED"),
                    ]
                )
            db.commit()
        login = client.post("/v1/auth/login", json={"email": "library@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        statements: list[str] = []

        def record(_conn, _cursor, statement, _parameters, _context, _executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", record)
        try:
            response = client.get("/v1/projects?view=summary", headers=headers)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert response.status_code == 200
        summaries = response.json()
        assert len(summaries) == 20
        assert {item["asset_count"] for item in summaries} == {3}
        assert {item["job_count"] for item in summaries} == {2}
        assert sum(item["has_active_jobs"] for item in summaries) == 10
        assert all(item["cover"] is not None and item["latest_job"] is not None for item in summaries)
        assert len(statements) <= 8, statements
        assert sum("from projects" in statement.lower() for statement in statements) == 1


def test_admin_governance() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True))
            db.add(User(email="person@example.com", password_hash=hash_password("correct-horse")))
            db.commit()
        root = client.post("/v1/auth/login", json={"email": "root@example.com", "password": "correct-horse"})
        admin = {"Authorization": f"Bearer {root.json()['access_token']}"}
        person = client.post("/v1/auth/login", json={"email": "person@example.com", "password": "correct-horse"})
        member = {"Authorization": f"Bearer {person.json()['access_token']}"}

        assert client.get("/v1/users", headers=member).status_code == 403
        found = client.get("/v1/users?query=PERSON", headers=admin)
        assert found.status_code == 200
        assert found.json()["total"] == 1
        assert [(item["email"], item["active"], item["is_admin"]) for item in found.json()["items"]] == [
            ("person@example.com", True, False)
        ]

        signed_in = client.get("/v1/auth/me", headers=admin).json()
        locked = client.patch(f"/v1/users/{signed_in['id']}", headers=admin, json={"active": False})
        assert locked.status_code == 409
        assert locked.headers["x-error-code"] == "admin.self_locked"

        target = found.json()["items"][0]["id"]
        assert client.patch(f"/v1/users/{target}", headers=admin, json={"active": False}).json()["active"] is False
        assert (
            client.post("/v1/auth/login", json={"email": "person@example.com", "password": "correct-horse"}).status_code
            == 401
        )
        assert (
            client.post(f"/v1/users/{target}/password", headers=admin, json={"password": "fresh-horse-1"}).status_code
            == 204
        )
        assert client.patch(f"/v1/users/{target}", headers=admin, json={"active": True}).json()["active"] is True
        assert (
            client.post("/v1/auth/login", json={"email": "person@example.com", "password": "correct-horse"}).status_code
            == 401
        )
        assert (
            client.post("/v1/auth/login", json={"email": "person@example.com", "password": "fresh-horse-1"}).status_code
            == 200
        )
        assert client.patch("/v1/users/missing", headers=admin, json={"active": False}).status_code == 404


def test_invitation_requires_one_time_claim_by_the_matching_account(monkeypatch) -> None:
    clock = datetime(2026, 11, 20, tzinfo=UTC)
    monkeypatch.setattr(main, "now", lambda: clock)
    with TestClient(app) as client:
        owner = client.post("/v1/auth/register", json={"email": "lead@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Invite"}).json()["id"]
        route = f"/v1/projects/{project_id}/members"
        pending_route = f"/v1/projects/{project_id}/invitations"
        accept_route = "/v1/project-invitations/accept"
        invited = client.post(route, headers=headers, json={"email": " Guest@Example.com ", "role": "viewer"})
        assert invited.status_code == 201
        assert invited.headers["cache-control"] == "no-store"
        issued = invited.json()
        code = issued.pop("claim_code")
        assert datetime.fromisoformat(issued.pop("expires_at")) == clock + timedelta(days=7)
        assert issued == {"status": "invited", "email": "guest@example.com", "role": "viewer"}
        digest = hashlib.sha256(code.encode()).hexdigest()
        with SessionLocal() as db:
            assert db.scalar(select(ProjectInvitation)).claim_digest == digest
        pending = client.get(pending_route, headers=headers)
        assert [item["email"] for item in pending.json()] == ["guest@example.com"]
        assert code not in pending.text and digest not in pending.text
        assert client.post(accept_route, json={"code": code}).status_code == 401
        wrong = client.post(accept_route, headers=headers, json={"code": code})
        assert wrong.status_code == 404

        guest = client.post("/v1/auth/register", json={"email": "guest@example.com", "password": "correct-horse"})
        guest_headers = {"Authorization": f"Bearer {guest.json()['access_token']}"}
        assert client.get("/v1/projects", headers=guest_headers).json() == []
        claimed = client.post(accept_route, headers=guest_headers, json={"code": code})
        assert claimed.status_code == 200
        assert claimed.json() == {"project_id": project_id, "role": "viewer"}
        reused = client.post(accept_route, headers=guest_headers, json={"code": code})
        assert reused.status_code == wrong.status_code
        assert reused.json() == wrong.json()
        assert reused.headers["x-error-code"] == wrong.headers["x-error-code"] == "invitation.unavailable"
        assert [item["id"] for item in client.get("/v1/projects", headers=guest_headers).json()] == [project_id]
        members = client.get(route, headers=headers).json()
        assert [(item["email"], item["role"]) for item in members] == [
            ("lead@example.com", "owner"),
            ("guest@example.com", "viewer"),
        ]
        assert client.get(pending_route, headers=headers).json() == []
        audit = client.get(f"/v1/projects/{project_id}/audit", headers=headers)
        assert code not in audit.text and digest not in audit.text
        assert [item["action"] for item in audit.json()["items"]].count("project.member.invite.accept") == 1

        known = client.post(route, headers=headers, json={"email": "guest@example.com", "role": "member"})
        guest_id = client.get("/v1/auth/me", headers=guest_headers).json()["id"]
        assert known.json() == {"status": "member", "user_id": guest_id, "role": "viewer"}
        assert [
            item["role"] for item in client.get(route, headers=headers).json() if item["email"] == "guest@example.com"
        ] == ["viewer"]


@pytest.mark.parametrize("reason", ["revoked", "rotated", "expired", "deleted", "disabled", "legacy"])
def test_existing_account_invitation_requires_active_code(monkeypatch, reason: str) -> None:
    clock = datetime(2026, 11, 20, tzinfo=UTC)
    monkeypatch.setattr(main, "now", lambda: clock)
    with TestClient(app) as client:
        owner = client.post("/v1/auth/register", json={"email": "lead@example.com", "password": "correct-horse"})
        owner_headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        guest = client.post("/v1/auth/register", json={"email": "guest@example.com", "password": "correct-horse"})
        guest_headers = {"Authorization": f"Bearer {guest.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=owner_headers, json={"name": "Invite"}).json()["id"]
        route = f"/v1/projects/{project_id}"
        invitation = {"email": "guest@example.com", "role": "member"}
        issued = client.post(f"{route}/members", headers=owner_headers, json=invitation).json()
        assert issued["status"] == "invited"
        assert client.get(route, headers=guest_headers).status_code == 403
        invitation_id = client.get(f"{route}/invitations", headers=owner_headers).json()[0]["id"]
        code = issued["claim_code"]
        if reason == "revoked":
            assert client.delete(f"{route}/invitations/{invitation_id}", headers=owner_headers).status_code == 204
        elif reason == "rotated":
            new = client.post(f"{route}/members", headers=owner_headers, json=invitation).json()
            assert new["claim_code"] != code
        elif reason == "expired":
            clock += timedelta(days=7)
        elif reason == "deleted":
            assert client.delete(route, headers=owner_headers).status_code == 204
        elif reason == "disabled":
            with SessionLocal.begin() as db:
                db.scalar(select(User).where(User.email == invitation["email"])).active = False
        elif reason == "legacy":
            with SessionLocal.begin() as db:
                legacy = db.get(ProjectInvitation, invitation_id)
                legacy.claim_digest = None
                legacy.expires_at = None
        response = client.post("/v1/project-invitations/accept", headers=guest_headers, json={"code": code})
        if reason == "disabled":
            assert response.status_code == 401
        else:
            assert response.status_code == 404
            assert response.headers["x-error-code"] == "invitation.unavailable"
            assert client.get("/v1/projects", headers=guest_headers).json() == []
        if reason == "rotated":
            response = client.post(
                "/v1/project-invitations/accept", headers=guest_headers, json={"code": new["claim_code"]}
            )
            assert response.json() == {"project_id": project_id, "role": "member"}


def test_job_stages_and_notifications(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_WORKER_TOKEN", "worker-test-token")
    main.settings.cache_clear()
    grant = TemporaryCredentials("id", "secret", "token", "later")
    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(worker_credentials=lambda *_: grant))
    try:
        with TestClient(app) as client:
            owner = client.post("/v1/auth/register", json={"email": "notify@example.com", "password": "correct-horse"})
            headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
            worker = {"Authorization": "Bearer worker-test-token", "X-Worker-Id": "notify-worker"}
            project_id = client.post("/v1/projects", headers=headers, json={"name": "Notified"}).json()["id"]
            with SessionLocal() as db:
                asset = Asset(
                    project_id=project_id,
                    object_key="photo",
                    filename="photo.jpg",
                    size=10,
                    content_type="image/jpeg",
                    status="READY",
                    sha256="a" * 64,
                )
                db.add(asset)
                db.commit()
                asset_id = asset.id
            job_id = client.post(
                f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]}
            ).json()["id"]
            with SessionLocal() as db:
                db.add_all(
                    [
                        JobStage(
                            job_id=job_id,
                            stage="colmap",
                            status="success",
                            progress=0.5,
                            metrics={"registered": 12},
                            created_at=now() - timedelta(seconds=2),
                        ),
                        JobStage(
                            job_id=job_id,
                            stage="gsplat",
                            status="success",
                            progress=1.0,
                            metrics={"iterations": 20000},
                            created_at=now() - timedelta(seconds=1),
                        ),
                    ]
                )
                db.commit()

            stages = client.get(f"/v1/jobs/{job_id}/stages", headers=headers).json()
            assert [row["stage"] for row in stages][:2] == ["colmap", "gsplat"]
            by_stage = {row["stage"]: row for row in stages}
            assert by_stage["colmap"]["metrics"] == {"registered": 12}
            assert by_stage["gsplat"]["metrics"] == {"iterations": 20000}
            assert by_stage["queued"]["progress"] == 0.0
            assert client.get("/v1/jobs/missing/stages", headers=headers).status_code == 404

            leased = client.post("/v1/worker/lease", headers=worker).json()["job"]
            completion = {
                "artifacts": [
                    {
                        "kind": kind,
                        "object_key": f"{leased['output_prefix']}artifacts/{kind}/result",
                        "sha256": "a" * 64,
                        "size": 10,
                        "content_type": "application/octet-stream",
                    }
                    for kind in ("spz", "ply", "metrics", "report")
                ]
            }
            completed = client.post(
                f"/v1/worker/jobs/{job_id}/complete",
                headers={**worker, "X-Lease-Attempt": str(leased["attempt"])},
                json=completion,
            )
            assert completed.status_code == 200

            unread = client.get("/v1/notifications?unread=1", headers=headers).json()
            assert [(item["kind"], item["job_id"]) for item in unread] == [("job.succeeded", job_id)]
            assert client.post("/v1/notifications/read", headers=headers, json={}).json() == {"updated": 1}
            assert client.get("/v1/notifications?unread=1", headers=headers).json() == []
            assert [item["kind"] for item in client.get("/v1/notifications", headers=headers).json()] == [
                "job.succeeded"
            ]
    finally:
        main.settings.cache_clear()


def test_auth_rate_limit(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_AUTH_RATE_LIMIT", "3")
    main.settings.cache_clear()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                db.add(User(email="limited@example.com", password_hash=hash_password("correct-horse")))
                db.commit()
            payload = {"email": "limited@example.com", "password": "correct-horse"}
            for _ in range(3):
                assert client.post("/v1/auth/login", json=payload).status_code == 200
            blocked = client.post("/v1/auth/login", json=payload)
            assert blocked.status_code == 429
            assert blocked.headers["x-error-code"] == "auth.rate_limited"
            assert int(blocked.headers["retry-after"]) >= 1
    finally:
        main.settings.cache_clear()


def test_rate_limit_ignores_rotated_forwarded_for(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_AUTH_RATE_LIMIT", "3")
    main.settings.cache_clear()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                db.add(User(email="spoofed@example.com", password_hash=hash_password("correct-horse")))
                db.commit()
            payload = {"email": "spoofed@example.com", "password": "correct-horse"}
            for index in range(3):
                spoof = {"X-Forwarded-For": f"203.0.113.{index}, 10.0.0.1"}
                assert client.post("/v1/auth/login", headers=spoof, json=payload).status_code == 200
            blocked = client.post("/v1/auth/login", headers={"X-Forwarded-For": "198.51.100.7"}, json=payload)
            assert blocked.status_code == 429
            assert blocked.headers["x-error-code"] == "auth.rate_limited"
            assert int(blocked.headers["retry-after"]) >= 1
    finally:
        main.settings.cache_clear()


def test_rate_limit_separates_verified_client_addresses(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_AUTH_RATE_LIMIT", "2")
    main.settings.cache_clear()
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                db.add(User(email="addressed@example.com", password_hash=hash_password("correct-horse")))
                db.commit()
            payload = {"email": "addressed@example.com", "password": "correct-horse"}
            first, second = {"X-Real-IP": "203.0.113.10"}, {"X-Real-IP": "203.0.113.11"}
            for headers in (first, first):
                assert client.post("/v1/auth/login", headers=headers, json=payload).status_code == 200
            assert client.post("/v1/auth/login", headers=first, json=payload).status_code == 429
            for headers in (second, second):
                assert client.post("/v1/auth/login", headers=headers, json=payload).status_code == 200
            assert client.post("/v1/auth/login", headers=second, json=payload).status_code == 429
            malformed = client.post("/v1/auth/login", headers={"X-Real-IP": "not-an-ip"}, json=payload)
            assert malformed.status_code == 200
    finally:
        main.settings.cache_clear()


def test_rate_limiter_prunes_idle_keys() -> None:
    limiter.reset()
    limiter.allow("idle:path", 5, 0.01)
    assert "idle:path" in limiter._hits
    time.sleep(0.02)
    limiter._next_prune = 0.0
    limiter.allow("fresh:path", 5, 60)
    assert "idle:path" not in limiter._hits
    assert "fresh:path" in limiter._hits
    limiter.reset()


def test_oversized_request_body_is_rejected() -> None:
    with TestClient(app) as client:
        oversized = b"a" * (3 * 1024 * 1024)
        declared = client.post(
            "/v1/auth/register",
            content=oversized,
            headers={"Content-Type": "application/json"},
        )
        assert declared.status_code == 413
        streamed = client.post(
            "/v1/auth/register",
            content=iter([oversized[: 1024 * 1024], oversized[1024 * 1024 :]]),
            headers={"Content-Type": "application/json"},
        )
        assert streamed.status_code == 413
    with SessionLocal() as db:
        assert db.query(User).count() == 0


def test_email_normalization_across_admin_and_invitations() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            admin = User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True)
            db.add(admin)
            db.commit()
            admin_headers = {"Authorization": f"Bearer {issue_token(admin.id)}"}
        created = client.post(
            "/v1/users",
            headers=admin_headers,
            json={"email": "  Staff@Example.COM  ", "password": "correct-horse"},
        )
        assert created.status_code == 201
        assert created.json()["email"] == "staff@example.com"
        assert (
            client.post("/v1/auth/login", json={"email": "STAFF@example.com", "password": "correct-horse"}).status_code
            == 200
        )
        for invalid in ("broken", "space inside@example.com", f"{'a' * 320}@example.com"):
            assert (
                client.post(
                    "/v1/users",
                    headers=admin_headers,
                    json={"email": invalid, "password": "correct-horse"},
                ).status_code
                == 422
            )
        assert (
            client.post(
                "/v1/auth/login",
                json={"email": "staff@example.com", "password": "x" * 2000},
            ).status_code
            == 422
        )

        owner = client.post("/v1/auth/register", json={"email": "  Spaced@Example.com ", "password": "correct-horse"})
        assert owner.status_code == 201
        owner_headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=owner_headers, json={"name": "Invites"}).json()["id"]
        invited = client.post(
            f"/v1/projects/{project_id}/members",
            headers=owner_headers,
            json={"email": "  Guest@Example.COM ", "role": "viewer"},
        )
        assert invited.status_code == 201
        assert invited.json()["email"] == "guest@example.com"
        with SessionLocal() as db:
            assert db.scalar(select(ProjectInvitation.email)) == "guest@example.com"
        assert (
            client.post(
                f"/v1/projects/{project_id}/members",
                headers=owner_headers,
                json={"email": "not-an-email"},
            ).status_code
            == 422
        )


def test_complete_asset_reports_retryable_conflict_codes(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)

    def head(*_):
        raise oss2.exceptions.NotFound(404, {}, b"", {})

    with TestClient(app) as client:
        headers, _, grant = register_asset(client, "conflicts@example.com")
        asset_id = str(grant["asset_id"])
        complete = f"/v1/assets/{asset_id}/complete"

        monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(head=head))
        incomplete = client.post(complete, headers=headers, json={"size": 2048, "sha256": "a" * 64})
        assert incomplete.status_code == 409
        assert incomplete.headers["x-error-code"] == "asset.upload_incomplete"

        monkeypatch.setattr(
            main,
            "storage",
            lambda: SimpleNamespace(head=lambda _: (1024, "image/jpeg")),
        )
        sized = client.post(complete, headers=headers, json={"size": 2048, "sha256": "a" * 64})
        assert sized.status_code == 409
        assert sized.headers["x-error-code"] == "asset.upload_size_mismatch"

        monkeypatch.setattr(
            main,
            "storage",
            lambda: SimpleNamespace(head=lambda _: (2048, "image/jpeg")),
        )
        hashed = client.post(complete, headers=headers, json={"size": 2048, "sha256": "b" * 64})
        assert hashed.status_code == 409
        assert hashed.headers["x-error-code"] == "asset.upload_hash_mismatch"

        completed = client.post(complete, headers=headers, json={"size": 2048, "sha256": "a" * 64})
        assert completed.status_code == 200
        assert completed.json()["status"] == "READY"
        repeated = client.post(f"/v1/assets/{asset_id}/upload-session", headers=headers)
        assert repeated.status_code == 409
        assert repeated.headers["x-error-code"] == "asset.not_awaiting_upload"


def test_upload_session_rolls_back_when_credentials_fail(monkeypatch) -> None:
    store = RecordingStore()

    def unavailable():
        raise HTTPException(503, "OSS is not configured")

    route_headers: dict[str, str] = {}
    with TestClient(app) as client:
        created = client.post(
            "/v1/auth/register", json={"email": "credentials@example.com", "password": "correct-horse"}
        )
        route_headers = {"Authorization": f"Bearer {created.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=route_headers, json={"name": "Credentials"}).json()["id"]
        route = f"/v1/projects/{project_id}/assets/upload-session"
        payload = {"filename": "frame.jpg", "size": 2048, "content_type": "image/jpeg", "sha256": "a" * 64}

        monkeypatch.setattr(main, "storage", unavailable)
        failed = client.post(route, headers=route_headers, json=payload)
        assert failed.status_code == 503
        assert failed.headers["x-error-code"] == "asset.upload_credentials_unavailable"
        assert failed.headers["retry-after"] == "30"
        with SessionLocal() as db:
            assert db.scalars(select(Asset)).all() == []
            assert db.scalars(select(AuditLog).where(AuditLog.action == "asset.upload.init")).all() == []

        monkeypatch.setattr(main, "storage", lambda: store)
        created_session = client.post(route, headers=route_headers, json=payload)
        assert created_session.status_code == 201
        assert created_session.json()["asset_id"]
        with SessionLocal() as db:
            asset = db.scalar(select(Asset))
            assert asset is not None and asset.status == "UPLOADING"
            audit_row = db.scalar(select(AuditLog).where(AuditLog.action == "asset.upload.init"))
            assert audit_row is not None and audit_row.target_id == asset.id


def test_stale_upload_expiry_is_bounded_per_request(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app) as client:
        headers, project_id, _ = register_asset(client, "bounded@example.com")
        stale_at = now() - timedelta(days=2)
        with SessionLocal() as db:
            db.add_all(
                Asset(
                    project_id=project_id,
                    object_key=f"bounded/{index}",
                    filename=f"frame-{index}.jpg",
                    size=10,
                    content_type="image/jpeg",
                    created_at=stale_at,
                )
                for index in range(75)
            )
            db.commit()
        route = f"/v1/projects/{project_id}/assets"
        for expected in (20, 40, 60, 75):
            assert client.get(route, headers=headers).status_code == 200
            with SessionLocal() as db:
                assert db.scalar(select(func.count()).select_from(AssetCleanup)) == expected
        assert store.deleted == []


def test_cleanup_queue_stops_retrying_permanent_failures(monkeypatch) -> None:
    store = RecordingStore()
    monkeypatch.setattr(main, "storage", lambda: store)
    with TestClient(app) as client:
        headers, _, grant = register_asset(client, "permanent@example.com")
        assert client.delete(f"/v1/assets/{grant['asset_id']}", headers=headers).status_code == 204
        with SessionLocal() as db:
            record = db.scalar(select(AssetCleanup))
            assert record is not None
            record.attempts = main.CLEANUP_MAX_ATTEMPTS - 1
            store.errors[record.object_key] = oss2.exceptions.OssError(503, {}, "ServiceUnavailable", {})
            db.commit()
        assert main.reap_asset_cleanups() == 0
        with SessionLocal() as db:
            record = db.scalar(select(AssetCleanup))
            assert record.attempts == main.CLEANUP_MAX_ATTEMPTS
            record.next_attempt_at = now() - timedelta(seconds=1)
            db.commit()
        assert main.reap_asset_cleanups() == 0
        with SessionLocal() as db:
            record = db.scalar(select(AssetCleanup))
            assert record is not None and record.attempts == main.CLEANUP_MAX_ATTEMPTS
            assert record.last_error is not None
        assert store.deleted == []


def test_share_qr_and_audit() -> None:
    with TestClient(app) as client:
        owner = client.post("/v1/auth/register", json={"email": "sharer@example.com", "password": "correct-horse"})
        headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=headers, json={"name": "Shared"}).json()["id"]
        with SessionLocal() as db:
            job = ReconstructionJob(project_id=project_id, profile="balanced", status="SUCCEEDED")
            db.add(job)
            db.flush()
            reconstruction = Reconstruction(project_id=project_id, job_id=job.id, version=1)
            db.add(reconstruction)
            db.commit()
            reconstruction_id = reconstruction.id

        created = client.post(f"/v1/reconstructions/{reconstruction_id}/shares", headers=headers, json={})
        assert created.status_code == 201
        token = created.json()["token"]
        image = client.get(f"/v1/public/shares/{token}/qr.png")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        assert image.content.startswith(b"\x89PNG")
        assert client.delete(f"/v1/shares/{created.json()['id']}", headers=headers).status_code == 204
        gone = client.get(f"/v1/public/shares/{token}/qr.png")
        assert gone.status_code == 404
        assert gone.headers["x-error-code"] == "share.not_found"

        assert client.patch(f"/v1/projects/{project_id}", headers=headers, json={"name": "Renamed"}).status_code == 200
        entries = client.get(f"/v1/projects/{project_id}/audit", headers=headers).json()
        actions = [entry["action"] for entry in entries["items"]]
        assert entries["total"] == len(entries["items"])
        assert "project.rename" in actions and "share.create" in actions
        assert {entry["actor_email"] for entry in entries["items"] if entry["action"] != "asset.expire"} == {
            "sharer@example.com"
        }

        with SessionLocal() as db:
            db.add(User(email="reader@example.com", password_hash=hash_password("correct-horse")))
            db.commit()
        reader = client.post("/v1/auth/login", json={"email": "reader@example.com", "password": "correct-horse"})
        reader_headers = {"Authorization": f"Bearer {reader.json()['access_token']}"}
        invitation = client.post(
            f"/v1/projects/{project_id}/members", headers=headers, json={"email": "reader@example.com"}
        ).json()
        assert (
            client.post(
                "/v1/project-invitations/accept", headers=reader_headers, json={"code": invitation["claim_code"]}
            ).status_code
            == 200
        )
        assert client.get(f"/v1/projects/{project_id}/audit", headers=reader_headers).status_code == 403


def test_user_directory_pagination_and_detail() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            root_user = User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True)
            db.add(root_user)
            db.commit()
            root_id = root_user.id
        root = client.post("/v1/auth/login", json={"email": "root@example.com", "password": "correct-horse"})
        admin = {"Authorization": f"Bearer {root.json()['access_token']}"}
        for email in ("alice@example.com", "bob@example.com"):
            created = client.post("/v1/users", headers=admin, json={"email": email, "password": "correct-horse"})
            assert created.status_code == 201

        page = client.get("/v1/users?limit=1&offset=1", headers=admin).json()
        assert page["total"] == 3
        assert [item["email"] for item in page["items"]] == ["bob@example.com"]
        assert client.get("/v1/users?active=false", headers=admin).json()["total"] == 0
        assert [item["email"] for item in client.get("/v1/users?is_admin=true", headers=admin).json()["items"]] == [
            "root@example.com"
        ]

        bob_id = client.get("/v1/users?query=bob", headers=admin).json()["items"][0]["id"]
        assert client.patch(f"/v1/users/{bob_id}", headers=admin, json={"active": False}).status_code == 200
        deactivated = client.get("/v1/users?active=false", headers=admin).json()
        assert deactivated["total"] == 1 and deactivated["items"][0]["id"] == bob_id
        assert client.patch(f"/v1/users/{bob_id}", headers=admin, json={"active": True}).status_code == 200

        alice = client.post("/v1/auth/login", json={"email": "alice@example.com", "password": "correct-horse"})
        alice_headers = {"Authorization": f"Bearer {alice.json()['access_token']}"}
        bob = client.post("/v1/auth/login", json={"email": "bob@example.com", "password": "correct-horse"})
        bob_headers = {"Authorization": f"Bearer {bob.json()['access_token']}"}
        alpha = client.post("/v1/projects", headers=alice_headers, json={"name": "Alpha"}).json()["id"]
        beta = client.post("/v1/projects", headers=bob_headers, json={"name": "Beta"}).json()["id"]
        invite = client.post(f"/v1/projects/{beta}/members", headers=bob_headers, json={"email": "alice@example.com"})
        assert invite.status_code == 201
        assert (
            client.post(
                "/v1/project-invitations/accept", headers=alice_headers, json={"code": invite.json()["claim_code"]}
            ).status_code
            == 200
        )

        alice_id = client.get("/v1/users?query=alice", headers=admin).json()["items"][0]["id"]
        detail = client.get(f"/v1/users/{alice_id}", headers=admin).json()
        assert detail["email"] == "alice@example.com"
        assert detail["memberships"] == [
            {"project_id": alpha, "name": "Alpha", "role": "owner"},
            {"project_id": beta, "name": "Beta", "role": "member"},
        ]
        assert client.get(f"/v1/users/{root_id}", headers=admin).json()["memberships"] == []

        assert client.get("/v1/users", headers=alice_headers).status_code == 403
        assert client.get(f"/v1/users/{alice_id}", headers=alice_headers).status_code == 403
        missing = client.get("/v1/users/missing", headers=admin)
        assert missing.status_code == 404 and missing.headers["x-error-code"] == "user.not_found"


def test_announcement_fanout_and_delete() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True))
            db.add(User(email="one@example.com", password_hash=hash_password("correct-horse")))
            db.add(User(email="two@example.com", password_hash=hash_password("correct-horse")))
            retired = User(email="retired@example.com", password_hash=hash_password("correct-horse"), active=False)
            db.add(retired)
            db.commit()
            retired_id = retired.id
            root_id = db.scalar(select(User.id).where(User.email == "root@example.com"))
        root = client.post("/v1/auth/login", json={"email": "root@example.com", "password": "correct-horse"})
        admin = {"Authorization": f"Bearer {root.json()['access_token']}"}
        one = client.post("/v1/auth/login", json={"email": "one@example.com", "password": "correct-horse"})
        one_headers = {"Authorization": f"Bearer {one.json()['access_token']}"}

        published = client.post(
            "/v1/announcements",
            headers=admin,
            json={"title": "维护通知", "body": "今晚 23:00 维护", "level": "warning"},
        )
        assert published.status_code == 201
        announcement = published.json()
        assert announcement["level"] == "warning"
        assert announcement["created_by"] == root_id

        assert [item["id"] for item in client.get("/v1/announcements", headers=admin).json()] == [announcement["id"]]
        assert client.get("/v1/notifications/count", headers=one_headers).json() == {"unread": 1}
        notices = client.get("/v1/notifications", headers=one_headers).json()
        assert [(item["kind"], item["announcement_id"], item["title"]) for item in notices] == [
            ("announcement", announcement["id"], "维护通知")
        ]
        with SessionLocal() as db:
            broadcast = db.scalars(select(Notification).where(Notification.announcement_id == announcement["id"])).all()
            retired_notices = db.scalars(select(Notification).where(Notification.user_id == retired_id)).all()
        assert len(broadcast) == 3
        assert retired_notices == []

        assert client.get("/v1/announcements", headers=one_headers).status_code == 403
        assert (
            client.post("/v1/announcements", headers=one_headers, json={"title": "t", "body": "b"}).status_code == 403
        )
        assert client.delete(f"/v1/announcements/{announcement['id']}", headers=one_headers).status_code == 403
        assert (
            client.post(
                "/v1/announcements", headers=admin, json={"title": "t", "body": "b", "level": "loud"}
            ).status_code
            == 422
        )

        assert client.delete(f"/v1/announcements/{announcement['id']}", headers=admin).status_code == 204
        assert client.get("/v1/notifications", headers=one_headers).json() == []
        assert client.get("/v1/notifications/count", headers=one_headers).json() == {"unread": 0}
        assert client.get("/v1/announcements", headers=admin).json() == []
        missing = client.delete(f"/v1/announcements/{announcement['id']}", headers=admin)
        assert missing.status_code == 404 and missing.headers["x-error-code"] == "announcement.not_found"


def test_notifications_follow_current_project_access() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            root = User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True)
            owner = User(email="owner@example.com", password_hash=hash_password("correct-horse"))
            member = User(email="member@example.com", password_hash=hash_password("correct-horse"))
            db.add_all([root, owner, member])
            db.flush()
            project = Project(name="Scope", owner_id=owner.id)
            db.add(project)
            db.flush()
            db.add(ProjectMember(project_id=project.id, user_id=member.id, role="member"))
            project_notice = Notification(
                user_id=member.id, kind="job_succeeded", title="项目完成", body="场景已就绪", project_id=project.id
            )
            other_notice = Notification(
                user_id=owner.id, kind="job_succeeded", title="项目完成", body="场景已就绪", project_id=project.id
            )
            announcement = Notification(user_id=member.id, kind="announcement", title="公告", body="维护")
            admin_notice = Notification(
                user_id=root.id, kind="job_succeeded", title="项目完成", body="场景已就绪", project_id=project.id
            )
            db.add_all([project_notice, other_notice, announcement, admin_notice])
            db.commit()
            project_id, member_id = project.id, member.id
            notice_id, announcement_id = project_notice.id, announcement.id
            admin_notice_id = admin_notice.id
        admin = client.post("/v1/auth/login", json={"email": "root@example.com", "password": "correct-horse"})
        admin_headers = {"Authorization": f"Bearer {admin.json()['access_token']}"}
        member_headers = {
            "Authorization": f"Bearer {client.post('/v1/auth/login', json={'email': 'member@example.com', 'password': 'correct-horse'}).json()['access_token']}"
        }
        owner_headers = {
            "Authorization": f"Bearer {client.post('/v1/auth/login', json={'email': 'owner@example.com', 'password': 'correct-horse'}).json()['access_token']}"
        }

        listed = [item["id"] for item in client.get("/v1/notifications", headers=member_headers).json()]
        assert len(listed) == 2 and set(listed) == {announcement_id, notice_id}
        assert client.get("/v1/notifications/count", headers=member_headers).json() == {"unread": 2}
        first_page = client.get("/v1/notifications?limit=1", headers=member_headers).json()
        second_page = client.get("/v1/notifications?limit=1&offset=1", headers=member_headers).json()
        assert len(first_page) == len(second_page) == 1
        assert {first_page[0]["id"], second_page[0]["id"]} == {announcement_id, notice_id}

        with SessionLocal() as db:
            db.execute(
                delete(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == member_id)
            )
            db.commit()

        assert [item["id"] for item in client.get("/v1/notifications", headers=member_headers).json()] == [
            announcement_id
        ]
        assert client.get("/v1/notifications/count", headers=member_headers).json() == {"unread": 1}
        assert client.post("/v1/notifications/read", headers=member_headers, json={"ids": [notice_id]}).json() == {
            "updated": 0
        }
        with SessionLocal() as db:
            assert db.get(Notification, notice_id).read_at is None, "a hidden notice must not be marked read"
            assert db.get(Notification, announcement_id).read_at is None
        assert client.post("/v1/notifications/read", headers=member_headers, json={}).json() == {"updated": 1}

        assert [item["id"] for item in client.get("/v1/notifications", headers=owner_headers).json()] == [
            other_notice.id
        ]
        assert [item["id"] for item in client.get("/v1/notifications", headers=admin_headers).json()] == [
            admin_notice_id
        ]

        with SessionLocal() as db:
            db.get(Project, project_id).deleted_at = now()
            db.commit()

        assert client.get("/v1/notifications", headers=owner_headers).json() == []
        assert client.get("/v1/notifications/count", headers=owner_headers).json() == {"unread": 0}
        assert client.get("/v1/notifications", headers=admin_headers).json() == []

        assert len(client.get("/v1/notifications?limit=1", headers=member_headers).json()) == 1


def test_global_audit_filters_and_csv() -> None:
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(email="root@example.com", password_hash=hash_password("correct-horse"), is_admin=True))
            db.commit()
        root = client.post("/v1/auth/login", json={"email": "root@example.com", "password": "correct-horse"})
        admin = {"Authorization": f"Bearer {root.json()['access_token']}"}
        owner = client.post("/v1/auth/register", json={"email": "owner@example.com", "password": "correct-horse"})
        owner_headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        project_id = client.post("/v1/projects", headers=owner_headers, json={"name": "Audited"}).json()["id"]
        assert (
            client.patch(f"/v1/projects/{project_id}", headers=owner_headers, json={"name": "Renamed"}).status_code
            == 200
        )
        assert (
            client.post("/v1/announcements", headers=admin, json={"title": "公告", "body": "内容"}).status_code == 201
        )
        target = client.get("/v1/users?query=owner", headers=admin).json()["items"][0]["id"]
        assert client.patch(f"/v1/users/{target}", headers=admin, json={"is_admin": False}).status_code == 200

        everything = client.get("/v1/audit?limit=100", headers=admin).json()
        assert everything["total"] == len(everything["items"])
        assert {item["action"] for item in everything["items"]} >= {
            "user.register",
            "project.create",
            "project.rename",
            "announcement.publish",
            "user.update",
        }

        by_actor = client.get("/v1/audit?actor=OWNER", headers=admin).json()
        assert by_actor["items"] and {item["actor_email"] for item in by_actor["items"]} == {"owner@example.com"}

        by_prefix = client.get("/v1/audit?action=user.", headers=admin).json()
        assert {item["action"] for item in by_prefix["items"]} == {"user.register", "user.update"}

        by_project = client.get(f"/v1/audit?project_id={project_id}", headers=admin).json()
        assert by_project["items"] and all(item["project_id"] == project_id for item in by_project["items"])
        assert by_project["items"][0]["project_name"] == "Renamed"

        actions = client.get("/v1/audit/actions", headers=admin).json()
        assert actions == sorted(actions) and "project.rename" in actions

        future = (now() + timedelta(days=1)).isoformat().replace("+00:00", "Z")
        assert client.get(f"/v1/audit?since={future}", headers=admin).json()["total"] == 0
        past = (now() - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        assert client.get(f"/v1/audit?since={past}", headers=admin).json()["total"] == everything["total"]
        invalid = client.get("/v1/audit?since=nope", headers=admin)
        assert invalid.status_code == 422 and invalid.headers["x-error-code"] == "audit.invalid_time"

        exported = client.get("/v1/audit.csv?action=project.", headers=admin)
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith("text/csv")
        assert 'filename="audit.csv"' in exported.headers["content-disposition"]
        rows = exported.text.lstrip("\ufeff").strip().splitlines()
        assert rows[0] == "time,actor,action,target_type,target_id,project_id,project_name,metadata"
        assert len(rows) - 1 == client.get("/v1/audit?action=project.", headers=admin).json()["total"]

        assert client.get("/v1/audit", headers=owner_headers).status_code == 403
        assert client.get("/v1/audit.csv", headers=owner_headers).status_code == 403
        assert client.get("/v1/audit/actions", headers=owner_headers).status_code == 403


def test_job_logs_append_read_and_retention(monkeypatch) -> None:
    monkeypatch.setenv("RESCENE_WORKER_TOKEN", "worker-test-token")
    main.settings.cache_clear()
    grant = TemporaryCredentials("id", "secret", "token", "later")
    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(worker_credentials=lambda *_: grant))
    try:
        with TestClient(app) as client:
            owner = client.post("/v1/auth/register", json={"email": "logger@example.com", "password": "correct-horse"})
            headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
            worker = {"Authorization": "Bearer worker-test-token", "X-Worker-Id": "log-worker"}
            project_id = client.post("/v1/projects", headers=headers, json={"name": "Logs"}).json()["id"]
            with SessionLocal() as db:
                asset = Asset(
                    project_id=project_id,
                    object_key="photo",
                    filename="photo.jpg",
                    size=10,
                    content_type="image/jpeg",
                    status="READY",
                    sha256="a" * 64,
                )
                db.add(asset)
                db.commit()
                asset_id = asset.id
            job_id = client.post(
                f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]}
            ).json()["id"]
            leased = client.post("/v1/worker/lease", headers=worker).json()["job"]
            route = f"/v1/worker/jobs/{job_id}/logs"
            lines = [
                {"level": "info", "message": "colmap started"},
                {"level": "warning", "message": "sparse model warning"},
                {"level": "error", "message": "gsplat failed to converge"},
            ]
            assert client.post(route, headers=worker, json={"attempt": leased["attempt"], "lines": lines}).json() == {
                "accepted": 3
            }

            logs = client.get(f"/v1/jobs/{job_id}/logs", headers=headers).json()["items"]
            assert [item["message"] for item in logs] == [line["message"] for line in lines]
            assert [item["level"] for item in logs] == ["info", "warning", "error"]
            assert logs[0]["created_at"] and logs[0]["id"] < logs[1]["id"] < logs[2]["id"]

            tail = client.get(f"/v1/jobs/{job_id}/logs?after_id={logs[0]['id']}", headers=headers).json()["items"]
            assert [item["message"] for item in tail] == ["sparse model warning", "gsplat failed to converge"]
            head = client.get(f"/v1/jobs/{job_id}/logs?before_id={logs[2]['id']}", headers=headers).json()["items"]
            assert [item["message"] for item in head] == ["colmap started", "sparse model warning"]
            errors = client.get(f"/v1/jobs/{job_id}/logs?level=error", headers=headers).json()["items"]
            assert [item["message"] for item in errors] == ["gsplat failed to converge"]

            stale = client.post(route, headers=worker, json={"attempt": leased["attempt"] + 5, "lines": lines})
            assert stale.status_code == 409
            assert client.get("/v1/jobs/missing/logs", headers=headers).status_code == 404
            outsider = client.post(
                "/v1/auth/register", json={"email": "nosey@example.com", "password": "correct-horse"}
            )
            outsider_headers = {"Authorization": f"Bearer {outsider.json()['access_token']}"}
            assert client.get(f"/v1/jobs/{job_id}/logs", headers=outsider_headers).status_code == 403

            monkeypatch.setenv("RESCENE_JOB_LOG_LIMIT", "2")
            main.settings.cache_clear()
            client.post(
                route,
                headers=worker,
                json={
                    "attempt": leased["attempt"],
                    "lines": [{"level": "info", "message": "tail one"}, {"level": "info", "message": "tail two"}],
                },
            )
            trimmed = client.get(f"/v1/jobs/{job_id}/logs?limit=500", headers=headers).json()["items"]
            assert [item["message"] for item in trimmed] == ["tail one", "tail two"]
    finally:
        main.settings.cache_clear()
