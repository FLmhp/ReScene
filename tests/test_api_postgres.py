import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, Table, create_engine, delete, event, inspect, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from rescene_api import main
from rescene_api.auth import hash_password, issue_token, verify_password
from rescene_api.config import settings
from rescene_api.models import (
    Asset,
    AssetCleanup,
    AuditLog,
    JobStage,
    Notification,
    Project,
    ProjectInvitation,
    ProjectMember,
    ReconstructionJob,
    User,
)
from rescene_api.schemas import ChangePasswordRequest
from rescene_api.storage import TemporaryCredentials


def migrate(connection, revision):
    migration = Config()
    migration.set_main_option("script_location", "rescene_api:migrations")
    migration.attributes["connection"] = connection
    command.upgrade(migration, revision)


@pytest.fixture
def postgres_sessions(monkeypatch, request):
    url = os.environ.get("RESCENE_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Set RESCENE_TEST_POSTGRES_URL to run the PostgreSQL concurrency smoke")
    if make_url(url).get_backend_name() != "postgresql":
        pytest.fail("RESCENE_TEST_POSTGRES_URL must point to a disposable PostgreSQL database")
    schema = f"rescene_test_{uuid4().hex}"
    admin_engine = create_engine(url)
    with admin_engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def set_search_path(connection, _):
        with connection.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{schema}"')
        connection.commit()

    try:
        with engine.begin() as connection:
            migrate(connection, getattr(request, "param", "head"))
        sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        monkeypatch.setattr(main, "SessionLocal", sessions)
        monkeypatch.setattr(main, "init_db", lambda: None)
        yield sessions
    finally:
        engine.dispose()
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin_engine.dispose()


def test_postgres_reapers_fence_late_heartbeat(postgres_sessions):
    with postgres_sessions.begin() as db:
        owner = User(email="lease@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Recovery", owner_id=owner.id)
        db.add(project)
        db.flush()
        job = ReconstructionJob(
            project_id=project.id,
            profile="balanced",
            status="RUNNING",
            leased_by="w1",
            attempt=1,
            lease_expires_at=datetime.now(UTC) - timedelta(seconds=30),
            resume_artifact_key="checkpoint/test-bundle",
        )
        db.add(job)
        db.flush()
        job_id = job.id

    barrier = Barrier(3)

    def reap():
        barrier.wait(timeout=10)
        main.reap_once()

    def late_heartbeat(client):
        barrier.wait(timeout=10)
        return client.post(
            f"/v1/worker/jobs/{job_id}/heartbeat",
            headers={"Authorization": f"Bearer {settings().worker_token}", "X-Worker-ID": "w1", "X-Lease-Attempt": "1"},
            json={"progress": 0.9},
        )

    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=3) as pool:
        reapers = [pool.submit(reap) for _ in range(2)]
        late = pool.submit(late_heartbeat, client)
        assert late.result(timeout=15).status_code == 409
        for result in reapers:
            result.result(timeout=15)
    with postgres_sessions() as db:
        job = db.get(ReconstructionJob, job_id)
        assert job.status == "QUEUED" and job.attempt == 1 and job.leased_by is None and job.lease_expires_at is None
        assert job.resume_artifact_key == "checkpoint/test-bundle"


def test_postgres_concurrent_password_rotations_stay_monotonic(postgres_sessions):
    with postgres_sessions.begin() as db:
        owner = User(email="rotate@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        user_id = owner.id

    barrier = Barrier(2)
    outcomes: list[str] = []

    def rotate(password: str) -> None:
        with postgres_sessions() as db:
            user = db.get(User, user_id)
            barrier.wait(timeout=10)
            try:
                main.change_password(
                    ChangePasswordRequest(current_password="correct-horse", new_password=password),
                    db,
                    user,
                )
                outcomes.append("rotated")
            except Exception as error:  # the loser must observe a conflict, not a silent overwrite
                outcomes.append(getattr(error, "status_code", 500))

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(rotate, "first-password"), pool.submit(rotate, "second-password")]
        for future in futures:
            future.result(timeout=15)

    assert sorted(outcomes, key=str) == [409, "rotated"]
    with postgres_sessions() as db:
        current = db.get(User, user_id)
        assert current.token_version == 1, "only the winning rotation may advance the version"
        applied = [
            password
            for password in ("first-password", "second-password")
            if verify_password(password, current.password_hash)
        ]
        assert len(applied) == 1, "the losing rotation must not overwrite the applied password"


def test_postgres_notifications_follow_committed_membership(postgres_sessions):
    with postgres_sessions.begin() as db:
        owner = User(email="owner@example.com", password_hash=hash_password("correct-horse"))
        member = User(email="member@example.com", password_hash=hash_password("correct-horse"))
        db.add_all([owner, member])
        db.flush()
        project = Project(name="Scope", owner_id=owner.id)
        db.add(project)
        db.flush()
        db.add(ProjectMember(project_id=project.id, user_id=member.id, role="member"))
        notice = Notification(user_id=member.id, kind="job_succeeded", title="完成", body="就绪", project_id=project.id)
        db.add(notice)
        db.flush()
        member_id, project_id, notice_id = member.id, project.id, notice.id
    headers = {"Authorization": f"Bearer {issue_token(member_id)}"}

    with TestClient(main.app) as client, postgres_sessions() as removing:
        assert [item["id"] for item in client.get("/v1/notifications", headers=headers).json()] == [notice_id]
        removing.execute(
            delete(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == member_id)
        )
        assert [item["id"] for item in client.get("/v1/notifications", headers=headers).json()] == [notice_id], (
            "an uncommitted removal must not hide the notice"
        )
        removing.commit()
        assert client.get("/v1/notifications", headers=headers).json() == []
        assert client.get("/v1/notifications/count", headers=headers).json() == {"unread": 0}


@pytest.fixture
def worker_storage(monkeypatch):
    monkeypatch.setattr(
        main,
        "storage",
        lambda: SimpleNamespace(
            worker_credentials=lambda *_: TemporaryCredentials(
                access_key_id="ak",
                access_key_secret="sk",
                security_token="sts",
                expiration="2030-01-01T00:00:00Z",
            )
        ),
    )


def test_postgres_lease_locks_only_the_next_candidate(postgres_sessions, worker_storage, monkeypatch):
    with postgres_sessions.begin() as db:
        owner = User(email="lease-scope@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Lease scope", owner_id=owner.id)
        db.add(project)
        db.flush()
        assets = [
            Asset(
                project_id=project.id,
                object_key=f"lease-{index}",
                filename=f"{index}.jpg",
                size=1,
                content_type="image/jpeg",
                status="READY",
            )
            for index in range(2)
        ]
        db.add_all(assets)
        db.flush()
        jobs = []
        for index, asset in enumerate(assets):
            job = ReconstructionJob(
                project_id=project.id,
                profile="balanced",
                status="QUEUED",
                priority=1 - index,
                created_at=datetime.now(UTC) + timedelta(seconds=index),
            )
            db.add(job)
            db.flush()
            db.add(JobStage(job_id=job.id, stage="queued", status="QUEUED", message=json.dumps([asset.id])))
            jobs.append(job)
        owner_id = owner.id
        first_job, second_job = jobs[0].id, jobs[1].id
    headers = {"Authorization": f"Bearer {issue_token(owner_id)}"}
    worker = {"Authorization": f"Bearer {settings().worker_token}", "X-Worker-ID": "lease-scope-worker"}

    original_ids = main.queued_asset_ids
    claimed = Event()
    release = Event()

    def blocking_ids(db, job_id):
        if not claimed.is_set():
            claimed.set()
            assert release.wait(10), "test did not release the claim"
        return original_ids(db, job_id)

    monkeypatch.setattr(main, "queued_asset_ids", blocking_ids)
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as pool:
        leasing = pool.submit(client.post, "/v1/worker/lease", headers=worker)
        assert claimed.wait(10), "claim never reached the locked row"
        cancelling = pool.submit(client.post, f"/v1/jobs/{second_job}/cancel", headers=headers)
        try:
            cancelled = cancelling.result(timeout=5)
        except Exception as error:
            release.set()
            leasing.result(timeout=15)
            raise AssertionError("cancelling another queued job waited for the claim transaction") from error
        release.set()
        leased = leasing.result(timeout=15)
        assert cancelled.status_code == 200
        assert leased.status_code == 200 and leased.json()["job"]["job_id"] == first_job

    with postgres_sessions() as db:
        assert db.get(ReconstructionJob, first_job).status == "LEASED"
        assert db.get(ReconstructionJob, second_job).status == "CANCELLED"


def test_postgres_concurrent_leases_claim_one_job(postgres_sessions, worker_storage):
    with postgres_sessions.begin() as db:
        owner = User(email="lease-race@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Lease race", owner_id=owner.id)
        db.add(project)
        db.flush()
        assets = [
            Asset(
                project_id=project.id,
                object_key=f"race-{index}",
                filename=f"{index}.jpg",
                size=1,
                content_type="image/jpeg",
                status="READY",
            )
            for index in range(2)
        ]
        db.add_all(assets)
        db.flush()
        for index, asset in enumerate(assets):
            job = ReconstructionJob(
                project_id=project.id,
                profile="balanced",
                status="QUEUED",
                priority=1 - index,
                created_at=datetime.now(UTC) + timedelta(seconds=index),
            )
            db.add(job)
            db.flush()
            db.add(JobStage(job_id=job.id, stage="queued", status="QUEUED", message=json.dumps([asset.id])))
    barrier = Barrier(2)

    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as pool:

        def claim(worker_id):
            barrier.wait(timeout=10)
            return client.post(
                "/v1/worker/lease",
                headers={"Authorization": f"Bearer {settings().worker_token}", "X-Worker-ID": worker_id},
            ).json()

        futures = [pool.submit(claim, name) for name in ("race-a", "race-b")]
        results = [future.result(timeout=30) for future in futures]

    leased = [result["job"] for result in results if result["job"]]
    assert len(leased) == 1, "two concurrent workers must not both lease a job"
    with postgres_sessions() as db:
        active = db.scalars(select(ReconstructionJob).where(ReconstructionJob.status.in_(["LEASED", "RUNNING"]))).all()
        assert len(active) == 1 and active[0].id == leased[0]["job_id"]


@pytest.mark.parametrize("operation", ["create", "retry"])
def test_postgres_project_delete_job_race(postgres_sessions, operation):
    with postgres_sessions() as db:
        owner = User(email="race@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.commit()
        headers = {"Authorization": f"Bearer {issue_token(owner.id)}"}

    with TestClient(main.app) as client:
        for iteration in range(10):
            with postgres_sessions() as db:
                project = Project(owner_id=owner.id, name=f"Race {iteration}")
                db.add(project)
                db.flush()
                asset = Asset(
                    project_id=project.id,
                    object_key=f"asset-{iteration}",
                    filename="image.jpg",
                    size=1,
                    content_type="image/jpeg",
                    status="READY",
                )
                job = ReconstructionJob(project_id=project.id, profile="balanced", status="FAILED")
                db.add_all([asset, job])
                db.commit()
                project_id, asset_id, job_id = project.id, asset.id, job.id
            barrier = Barrier(2)

            def delete_project(*, barrier=barrier, project_id=project_id):
                barrier.wait(timeout=10)
                return client.delete(f"/v1/projects/{project_id}", headers=headers).status_code

            def submit_job(*, barrier=barrier, project_id=project_id, asset_id=asset_id, job_id=job_id):
                barrier.wait(timeout=10)
                if operation == "create":
                    return client.post(
                        f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]}
                    ).status_code
                return client.post(f"/v1/jobs/{job_id}/retry", headers=headers).status_code

            with ThreadPoolExecutor(max_workers=2) as pool:
                deletion = pool.submit(delete_project)
                submission = pool.submit(submit_job)
                delete_status, submit_status = deletion.result(timeout=30), submission.result(timeout=30)
            success = 201 if operation == "create" else 200
            assert (delete_status, submit_status) in {(409, success), (204, 404)}
            with postgres_sessions() as db:
                stored_project = db.get(Project, project_id)
                active = db.scalars(
                    select(ReconstructionJob).where(
                        ReconstructionJob.project_id == project_id,
                        ReconstructionJob.status.in_(["QUEUED", "LEASED", "RUNNING"]),
                    )
                ).all()
                assert not (stored_project.deleted_at is not None and active)


@pytest.mark.parametrize("operation", ["double_claim", "revoke", "rotate"])
def test_postgres_invitation_rechecks_credential_after_project_lock(postgres_sessions, operation):
    with postgres_sessions.begin() as db:
        owner = User(email="invite-owner@example.com", password_hash="unused")
        guest = User(email="invite-guest@example.com", password_hash="unused")
        db.add_all([owner, guest])
        db.flush()
        project = Project(owner_id=owner.id, name="Invited project")
        db.add(project)
        db.flush()
    route = f"/v1/projects/{project.id}"
    owner_headers = {"Authorization": f"Bearer {issue_token(owner.id)}"}
    guest_headers = {"Authorization": f"Bearer {issue_token(guest.id)}"}
    invite = {"email": guest.email, "role": "viewer"}
    engine = postgres_sessions.kw["bind"]
    lookup_complete, mutation_complete = Event(), Event()
    both_claims_ready = Barrier(2)

    def pause_after_lookup(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("SELECT project_invitations.project_id"):
            if operation == "double_claim":
                both_claims_ready.wait(timeout=10)
            else:
                lookup_complete.set()
                assert mutation_complete.wait(timeout=10)

    with TestClient(main.app) as client:
        issued = client.post(f"{route}/members", json=invite, headers=owner_headers)
        assert issued.status_code == 201
        claims = {"code": issued.json()["claim_code"]}
        pending = client.get(f"{route}/invitations", headers=owner_headers).json()[0]

        def accept():
            return client.post("/v1/project-invitations/accept", headers=guest_headers, json=claims).status_code

        event.listen(engine, "after_cursor_execute", pause_after_lookup)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(accept)
                if operation == "double_claim":
                    second = pool.submit(accept)
                    assert {first.result(timeout=15), second.result(timeout=15)} == {200, 404}
                else:
                    try:
                        assert lookup_complete.wait(timeout=10)
                        if operation == "revoke":
                            assert (
                                client.delete(f"{route}/invitations/{pending['id']}", headers=owner_headers).status_code
                                == 204
                            )
                        else:
                            assert (
                                client.post(f"{route}/members", headers=owner_headers, json=invite).status_code == 201
                            )
                    finally:
                        mutation_complete.set()
                    assert first.result(timeout=15) == 404
        finally:
            event.remove(engine, "after_cursor_execute", pause_after_lookup)
    with postgres_sessions() as db:
        member = db.scalar(select(ProjectMember).where(ProjectMember.user_id == guest.id))
        accepted_entries = db.scalars(select(AuditLog).where(AuditLog.action == "project.member.invite.accept")).all()
        if operation == "double_claim":
            assert member.role == "viewer" and len(accepted_entries) == 1
        else:
            assert member is None and not accepted_entries


@pytest.mark.parametrize("postgres_sessions", ["0006"], indirect=True)
def test_postgres_invitation_upgrade_preserves_inert_legacy_rows(postgres_sessions):
    with postgres_sessions.begin() as db:
        owner = User(email="legacy-owner@example.com", password_hash="unused")
        db.add(owner)
        db.flush()
        project = Project(owner_id=owner.id, name="Legacy project")
        db.add(project)
        db.flush()
        connection = db.connection()
        invitations = Table("project_invitations", MetaData(), autoload_with=connection)
        assert "claim_digest" not in invitations.c
        db.execute(
            invitations.insert(),
            [
                {
                    "id": action,
                    "project_id": project.id,
                    "email": f"legacy-{action}@example.com",
                    "role": "viewer",
                    "invited_by": owner.id,
                    "created_at": datetime.now(UTC),
                }
                for action in ("reissue", "revoke")
            ],
        )
    with postgres_sessions.kw["bind"].begin() as connection:
        migrate(connection, "head")
    with postgres_sessions() as db:
        pending = db.scalars(select(ProjectInvitation)).all()
        assert len(pending) == 2 and all(row.claim_digest is None and row.expires_at is None for row in pending)
    headers = {"Authorization": f"Bearer {issue_token(owner.id)}"}
    route = f"/v1/projects/{project.id}"
    with TestClient(main.app) as client:
        assert client.delete(f"{route}/invitations/revoke", headers=headers).status_code == 204
        reissued = client.post(f"{route}/members", headers=headers, json={"email": "legacy-reissue@example.com"})
        assert reissued.status_code == 201 and reissued.json()["claim_code"]
    with postgres_sessions() as db:
        pending = db.scalars(select(ProjectInvitation)).all()
        assert len(pending) == 1 and pending[0].id == "reissue" and pending[0].claim_digest


@pytest.fixture
def stale_upload(postgres_sessions):
    with postgres_sessions.begin() as db:
        owner = User(email="expiry@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Upload expiry", owner_id=owner.id)
        db.add(project)
        db.flush()
        asset = Asset(
            project_id=project.id,
            object_key="expiry/frame.jpg",
            filename="frame.jpg",
            size=10,
            content_type="image/jpeg",
            created_at=datetime.now(UTC) - timedelta(days=2),
        )
        db.add(asset)
        db.flush()
        return project.id, asset.id, asset.object_key, {"Authorization": f"Bearer {issue_token(owner.id)}"}


@pytest.mark.parametrize("commit_before_recheck", [False, True])
def test_postgres_stale_upload_preserves_completed_asset(
    postgres_sessions, stale_upload, monkeypatch, commit_before_recheck
):
    project_id, asset_id, object_key, headers = stale_upload
    objects = {object_key}
    checking_object, allow_completion = Event(), Event()

    def head(key):
        assert key in objects
        checking_object.set()
        assert allow_completion.wait(timeout=15)
        return 10, "image/jpeg"

    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(head=head, delete=objects.remove))
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as pool:
        completion = pool.submit(
            client.post, f"/v1/assets/{asset_id}/complete", headers=headers, json={"size": 10, "sha256": "a" * 64}
        )

        @event.listens_for(postgres_sessions.kw["bind"], "before_cursor_execute")
        def complete_before_recheck(_connection, _cursor, statement, _parameters, _context, _executemany):
            if commit_before_recheck and "FROM assets" in statement and "FOR UPDATE SKIP LOCKED" in statement:
                allow_completion.set()
                assert completion.result(timeout=10).status_code == 200

        try:
            assert checking_object.wait(timeout=10)
            cleanup = pool.submit(client.get, f"/v1/projects/{project_id}/assets", headers=headers)
            listing = cleanup.result(timeout=10)
            assert listing.status_code == 200
            expected_status = "READY" if commit_before_recheck else "UPLOADING"
            assert [(item["id"], item["status"]) for item in listing.json()["items"]] == [(asset_id, expected_status)]
            assert objects == {object_key}
        finally:
            allow_completion.set()
        completed = completion.result(timeout=10)
        assert completed.status_code == 200
        detail = client.get(f"/v1/projects/{project_id}", headers=headers)
        assert detail.status_code == 200
        assert [(item["id"], item["status"]) for item in detail.json()["assets"]] == [(asset_id, "READY")]

    assert objects == {object_key}
    with postgres_sessions() as db:
        assert db.get(Asset, asset_id).status == "READY"
        assert db.scalars(select(AuditLog.action).where(AuditLog.target_id == asset_id)).all() == [
            "asset.upload.complete"
        ]


def test_postgres_stale_upload_cleanup_fences_completion(postgres_sessions, stale_upload, monkeypatch):
    project_id, asset_id, object_key, headers = stale_upload
    objects = {object_key}
    deleted: list[str] = []
    deleting, allow_cleanup, completion_lock_query = Event(), Event(), Event()

    def delete(key):
        deleting.set()
        assert allow_cleanup.wait(timeout=15)
        objects.remove(key)
        deleted.append(key)

    def head(key):
        pytest.fail(f"Completion reached OSS after expiry of {key}")

    @event.listens_for(postgres_sessions.kw["bind"], "before_cursor_execute")
    def observe_completion_lock(_connection, _cursor, statement, _parameters, _context, _executemany):
        if "FROM assets" in statement and "FOR UPDATE" in statement and "SKIP LOCKED" not in statement:
            completion_lock_query.set()

    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(head=head, delete=delete))
    details = f"/v1/projects/{project_id}"
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as pool:
        cleanup = pool.submit(client.get, details, headers=headers)
        try:
            assert deleting.wait(timeout=10)
            assert objects == {object_key}
            completion = pool.submit(
                client.post, f"/v1/assets/{asset_id}/complete", headers=headers, json={"size": 10, "sha256": "a" * 64}
            )
            assert completion_lock_query.wait(timeout=10)
        finally:
            allow_cleanup.set()
        cleaned = cleanup.result(timeout=10)
        assert cleaned.status_code == 200 and cleaned.json()["assets"] == []
        missing = completion.result(timeout=10)
        assert missing.status_code == 404 and missing.json()["detail"] == "Asset not found"

        detail = client.get(details, headers=headers)
        listing = client.get(f"{details}/assets", headers=headers)
        assert detail.status_code == 200 and detail.json()["assets"] == []
        assert listing.status_code == 200 and listing.json()["items"] == []

    assert objects == set()
    assert deleted == [object_key]
    with postgres_sessions() as db:
        assert db.get(Asset, asset_id) is None
        assert db.scalars(select(AuditLog.action).where(AuditLog.target_id == asset_id)).all() == ["asset.expire"]


def test_postgres_same_key_creates_one_job(postgres_sessions, monkeypatch):
    with postgres_sessions.begin() as db:
        owner = User(email="idempotent@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Retry", owner_id=owner.id)
        db.add(project)
        db.flush()
        asset = Asset(
            project_id=project.id,
            object_key="idempotent/frame.jpg",
            filename="frame.jpg",
            size=10,
            content_type="image/jpeg",
            sha256="a" * 64,
            status="READY",
        )
        db.add(asset)
        db.flush()
        headers = {"Authorization": f"Bearer {issue_token(owner.id)}", "Idempotency-Key": "concurrent-1"}
        project_id, asset_id = project.id, asset.id

    barrier = Barrier(2)

    def submit(client):
        barrier.wait(timeout=10)
        return client.post(f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]})

    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, client) for _ in range(2)]
        responses = [future.result(timeout=30) for future in futures]

    assert [response.status_code for response in responses] == [201, 201]
    assert len({response.json()["id"] for response in responses}) == 1
    with postgres_sessions() as db:
        jobs = db.scalars(select(ReconstructionJob).where(ReconstructionJob.project_id == project_id)).all()
        assert len(jobs) == 1
        assert db.scalars(select(AuditLog).where(AuditLog.action == "job.create")).all() != []


@pytest.mark.parametrize("postgres_sessions", ["0007"], indirect=True)
def test_postgres_asset_cleanup_migration_reaches_head(postgres_sessions):
    with postgres_sessions.kw["bind"].begin() as connection:
        assert "asset_cleanups" not in set(inspect(connection).get_table_names())
        migrate(connection, "head")
        assert "asset_cleanups" in set(inspect(connection).get_table_names())
    with postgres_sessions() as db:
        assert db.scalars(select(AssetCleanup)).all() == []


def test_postgres_delete_queues_the_object_and_the_reaper_removes_it_once(postgres_sessions, monkeypatch):
    object_key = "queued/frame.jpg"
    deleted: list[str] = []
    monkeypatch.setattr(main, "storage", lambda: SimpleNamespace(delete=deleted.append))
    with postgres_sessions.begin() as db:
        owner = User(email="queue@example.com", password_hash=hash_password("correct-horse"))
        db.add(owner)
        db.flush()
        project = Project(name="Queued deletes", owner_id=owner.id)
        db.add(project)
        db.flush()
        asset = Asset(
            project_id=project.id,
            object_key=object_key,
            filename="frame.jpg",
            size=10,
            content_type="image/jpeg",
            sha256="a" * 64,
            status="READY",
        )
        db.add(asset)
        db.flush()
        headers = {"Authorization": f"Bearer {issue_token(owner.id)}"}
        project_id, asset_id = project.id, asset.id

    with TestClient(main.app) as client:
        # Deleting first removes the row from every later job's candidate set.
        assert client.delete(f"/v1/assets/{asset_id}", headers=headers).status_code == 204
        assert deleted == []
        refused = client.post(f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]})
        assert refused.status_code == 422
        with postgres_sessions() as db:
            queued = db.scalars(select(AssetCleanup)).all()
            assert [(row.object_key, row.reason, row.attempts) for row in queued] == [(object_key, "asset.delete", 0)]

        assert main.reap_asset_cleanups() == 1
        assert deleted == [object_key]
        assert main.reap_asset_cleanups() == 0
        assert deleted == [object_key]
        with postgres_sessions() as db:
            assert db.scalars(select(AssetCleanup)).all() == []
            assert db.get(Asset, asset_id) is None


def test_postgres_job_input_blocks_a_later_delete(postgres_sessions, stale_upload, monkeypatch):
    project_id, asset_id, object_key, headers = stale_upload
    deleted: list[str] = []
    monkeypatch.setattr(
        main,
        "storage",
        lambda: SimpleNamespace(head=lambda key: (10, "image/jpeg"), delete=lambda key: deleted.append(key)),
    )
    with postgres_sessions() as db:
        db.get(Asset, asset_id).status = "READY"
        db.commit()
    with TestClient(main.app) as client:
        created = client.post(f"/v1/projects/{project_id}/jobs", headers=headers, json={"asset_ids": [asset_id]})
        assert created.status_code == 201
        refused = client.delete(f"/v1/assets/{asset_id}", headers=headers)
        assert refused.status_code == 409
        assert refused.headers["x-error-code"] == "asset.in_use"
    with postgres_sessions() as db:
        assert db.get(Asset, asset_id) is not None
        assert db.scalars(select(AssetCleanup)).all() == []
    assert deleted == []
