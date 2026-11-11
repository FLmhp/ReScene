import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from rescene_api import main
from rescene_api.auth import hash_password, issue_token
from rescene_api.db import Base
from rescene_api.models import Asset, Project, ReconstructionJob, User


@pytest.fixture
def postgres_sessions(monkeypatch):
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
        Base.metadata.create_all(engine)
        sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        monkeypatch.setattr(main, "SessionLocal", sessions)
        monkeypatch.setattr(main, "init_db", lambda: None)
        yield sessions
    finally:
        engine.dispose()
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin_engine.dispose()


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
