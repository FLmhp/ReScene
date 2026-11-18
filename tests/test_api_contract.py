import json
from datetime import UTC, datetime, timedelta

import jwt
import oss2
import pytest
from fastapi.testclient import TestClient

from rescene_api.auth import hash_password, issue_token
from rescene_api.config import settings
from rescene_api.db import SessionLocal
from rescene_api.main import app
from rescene_api.models import Asset, JobStage, ProjectMember, Reconstruction, ReconstructionJob, User


def test_asset_preview_permissions_and_unavailable_inputs(accounts, project, monkeypatch):
    from unittest.mock import Mock

    import rescene_api.main as api

    store = Mock()
    store.signed_preview.return_value = "https://example.test/image-preview"
    monkeypatch.setattr(api, "storage", lambda: store)
    with SessionLocal() as db:
        image = Asset(
            project_id=project["id"],
            object_key="image.jpg",
            filename="image.jpg",
            size=5,
            content_type="image/jpeg",
            status="READY",
        )
        pending = Asset(
            project_id=project["id"],
            object_key="pending.jpg",
            filename="pending.jpg",
            size=5,
            content_type="image/jpeg",
            status="UPLOADING",
        )
        video = Asset(
            project_id=project["id"],
            object_key="video.mp4",
            filename="video.mp4",
            size=5,
            content_type="video/mp4",
            status="READY",
        )
        db.add_all([image, pending, video])
        db.commit()
        ids = image.id, pending.id, video.id
    with TestClient(app) as client:
        route = f"/v1/assets/{ids[0]}/preview"
        assert client.get(route).status_code == 401
        assert client.get(route, headers=accounts["outsider"]["headers"]).status_code == 403
        store.signed_preview.assert_not_called()
        for actor in ("owner", "member", "viewer", "admin"):
            response = client.get(route, headers=accounts[actor]["headers"])
            assert response.status_code == 200
            assert response.json()["url"] == "https://example.test/image-preview"
        for asset_id in ids[1:]:
            assert client.get(f"/v1/assets/{asset_id}/preview", headers=accounts["owner"]["headers"]).status_code == 409
        assert client.get("/v1/assets/missing/preview", headers=accounts["owner"]["headers"]).status_code == 404
        store.signed_preview.side_effect = oss2.exceptions.NoSuchKey(404, {}, b"", {})
        assert client.get(route, headers=accounts["owner"]["headers"]).status_code == 503


@pytest.fixture
def accounts():
    with SessionLocal() as db:
        password = hash_password("correct-horse")
        users = {
            name: User(email=f"{name}@example.com", password_hash=password, is_admin=name == "admin")
            for name in ("owner", "admin", "member", "viewer", "outsider", "unknown")
        }
        db.add_all(users.values())
        db.commit()
        return {
            name: {"id": user.id, "email": user.email, "headers": {"Authorization": f"Bearer {issue_token(user.id)}"}}
            for name, user in users.items()
        }


@pytest.fixture
def project(accounts):
    with TestClient(app) as client:
        response = client.post("/v1/projects", headers=accounts["owner"]["headers"], json={"name": "  Scene  "})
        assert response.status_code == 201
        project = response.json()
        assert project["name"] == "Scene"
        for name in ("member", "viewer"):
            response = client.post(
                f"/v1/projects/{project['id']}/members",
                headers=accounts["owner"]["headers"],
                json={"email": accounts[name]["email"], "role": name},
            )
            assert response.status_code == 201
            assert response.json() == {"status": "member", "user_id": accounts[name]["id"], "role": name}
        with SessionLocal() as db:
            db.add(ProjectMember(project_id=project["id"], user_id=accounts["unknown"]["id"], role="unexpected"))
            db.commit()
        return project


def test_identity_refresh_and_validation(accounts):
    with TestClient(app) as client:
        owner = accounts["owner"]
        assert client.get("/v1/auth/me").status_code == 401
        assert client.get("/v1/auth/me", headers=owner["headers"]).json() == {
            "id": owner["id"],
            "email": owner["email"],
            "is_admin": False,
        }
        assert client.post("/v1/auth/refresh", headers=owner["headers"]).status_code == 200
        expired = jwt.encode(
            {"sub": owner["id"], "ver": 0, "exp": datetime.now(UTC) - timedelta(seconds=1)},
            settings().jwt_secret,
            algorithm="HS256",
        )
        assert client.post("/v1/auth/refresh", headers={"Authorization": f"Bearer {expired}"}).status_code == 401
        assert (
            client.post(
                "/v1/users",
                headers=accounts["admin"]["headers"],
                json={"email": "new@example.com", "password": "short"},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/v1/users", headers=owner["headers"], json={"email": "new@example.com", "password": "correct-horse"}
            ).status_code
            == 403
        )
        for name in ("", "   "):
            assert client.post("/v1/projects", headers=owner["headers"], json={"name": name}).status_code == 422
        assert client.post("/v1/auth/logout", headers=owner["headers"]).status_code == 204
        assert client.get("/v1/auth/me", headers=owner["headers"]).status_code == 401


def test_project_roles_and_member_management(accounts, project):
    project_id = project["id"]
    route = f"/v1/projects/{project_id}"
    with TestClient(app) as client:
        for name in ("owner", "admin", "member", "viewer"):
            headers = accounts[name]["headers"]
            listed = client.get("/v1/projects", headers=headers).json()
            entry = next(item for item in listed if item["id"] == project_id)
            assert entry["owner_id"] == accounts["owner"]["id"]
            assert entry["effective_role"] == name
            detail = client.get(route, headers=headers)
            assert detail.status_code == 200
            assert detail.json()["owner_id"] == accounts["owner"]["id"]
            assert detail.json()["effective_role"] == name
            assert isinstance(detail.json()["assets"], list)
            assert isinstance(detail.json()["jobs"], list)
            members = client.get(f"{route}/members", headers=headers)
            assert members.status_code == 200
            assert {
                "user_id": accounts["owner"]["id"],
                "email": accounts["owner"]["email"],
                "role": "owner",
            } in members.json()
        assert project["effective_role"] == "owner"
        assert client.get(route, headers=accounts["outsider"]["headers"]).status_code == 403
        assert all(
            item["id"] != project_id
            for item in client.get("/v1/projects", headers=accounts["outsider"]["headers"]).json()
        )
        for name in ("member", "viewer", "outsider", "unknown"):
            headers = accounts[name]["headers"]
            assert client.patch(route, headers=headers, json={"name": "Denied"}).status_code == 403
            assert (
                client.post(
                    f"{route}/members", headers=headers, json={"email": accounts["outsider"]["email"]}
                ).status_code
                == 403
            )
            assert (
                client.patch(
                    f"{route}/members/{accounts['viewer']['id']}", headers=headers, json={"role": "member"}
                ).status_code
                == 403
            )
            assert client.delete(f"{route}/members/{accounts['viewer']['id']}", headers=headers).status_code == 403
            assert client.delete(route, headers=headers).status_code == 403
        owner_headers = accounts["owner"]["headers"]
        assert client.patch(route, headers=owner_headers, json={"name": "   "}).status_code == 422
        renamed = client.patch(route, headers=accounts["admin"]["headers"], json={"name": "  Renamed  "})
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Renamed" and renamed.json()["effective_role"] == "admin"
        for method in ("patch", "delete"):
            kwargs = {"json": {"role": "viewer"}} if method == "patch" else {}
            assert getattr(client, method)(
                f"{route}/members/{accounts['owner']['id']}", headers=owner_headers, **kwargs
            ).status_code in (403, 409, 422)
        changed = client.patch(
            f"{route}/members/{accounts['viewer']['id']}", headers=owner_headers, json={"role": "member"}
        )
        assert changed.status_code == 200
        assert changed.json() == {
            "user_id": accounts["viewer"]["id"],
            "email": accounts["viewer"]["email"],
            "role": "member",
        }
        assert (
            client.patch(
                f"{route}/members/{accounts['viewer']['id']}", headers=owner_headers, json={"role": "owner"}
            ).status_code
            == 422
        )
        assert (
            client.delete(
                f"{route}/members/{accounts['viewer']['id']}", headers=accounts["admin"]["headers"]
            ).status_code
            == 204
        )
        assert client.get(route, headers=accounts["viewer"]["headers"]).status_code == 403
        with SessionLocal() as db:
            db.get(User, accounts["owner"]["id"]).is_admin = True
            db.commit()
        assert client.get(route, headers=owner_headers).json()["effective_role"] == "owner"


def test_shares_writer_permissions_and_no_token_disclosure(accounts, project):
    with SessionLocal() as db:
        job = ReconstructionJob(project_id=project["id"], profile="balanced", status="SUCCEEDED")
        db.add(job)
        db.flush()
        reconstruction = Reconstruction(project_id=project["id"], job_id=job.id, version=1)
        db.add(reconstruction)
        db.commit()
        reconstruction_id = reconstruction.id
    route = f"/v1/reconstructions/{reconstruction_id}/shares"
    with TestClient(app) as client:
        for name in ("viewer", "outsider", "unknown"):
            headers = accounts[name]["headers"]
            assert client.get(route, headers=headers).status_code == 403
            assert client.post(route, headers=headers, json={}).status_code == 403
        created = client.post(route, headers=accounts["member"]["headers"], json={})
        assert created.status_code == 201
        share = created.json()
        assert share["token"]
        for name in ("owner", "admin", "member"):
            listing = client.get(route, headers=accounts[name]["headers"])
            assert listing.status_code == 200
            assert listing.json() == [{"id": share["id"], "expires_at": None, "revoked_at": None}]
            assert share["token"] not in listing.text
        for name in ("viewer", "outsider", "unknown"):
            assert client.delete(f"/v1/shares/{share['id']}", headers=accounts[name]["headers"]).status_code == 403
        assert client.delete(f"/v1/shares/{share['id']}", headers=accounts["member"]["headers"]).status_code == 204
        assert client.get(f"/v1/public/shares/{share['token']}").status_code in (403, 404, 410)
        assert client.get(route, headers=accounts["owner"]["headers"]).json()[0]["revoked_at"] is not None


def test_job_creation_requires_writer(accounts, project):
    with SessionLocal() as db:
        asset = Asset(
            project_id=project["id"],
            object_key="ready-image",
            filename="image.jpg",
            size=1,
            content_type="image/jpeg",
            status="READY",
        )
        db.add(asset)
        db.commit()
        asset_id = asset.id
    route = f"/v1/projects/{project['id']}/jobs"
    with TestClient(app) as client:
        for name in ("viewer", "outsider", "unknown"):
            assert (
                client.post(route, headers=accounts[name]["headers"], json={"asset_ids": [asset_id]}).status_code == 403
            )
        assert (
            client.post(route, headers=accounts["member"]["headers"], json={"asset_ids": [asset_id]}).status_code == 201
        )


@pytest.mark.parametrize("status", ["QUEUED", "LEASED", "RUNNING"])
def test_active_jobs_prevent_project_deletion(accounts, project, status):
    with SessionLocal() as db:
        db.add(ReconstructionJob(project_id=project["id"], profile="balanced", status=status))
        db.commit()
    with TestClient(app) as client:
        route = f"/v1/projects/{project['id']}"
        assert client.delete(route, headers=accounts["owner"]["headers"]).status_code == 409
        assert client.get(route, headers=accounts["owner"]["headers"]).status_code == 200


def test_event_resume_preserves_terminal_reconstruction(accounts, project):
    with SessionLocal() as db:
        job = ReconstructionJob(project_id=project["id"], profile="balanced", status="SUCCEEDED")
        db.add(job)
        db.flush()
        db.add_all(
            [
                JobStage(job_id=job.id, stage="first", status="success"),
                JobStage(job_id=job.id, stage="second", status="success"),
            ]
        )
        reconstruction = Reconstruction(project_id=project["id"], job_id=job.id, version=1)
        db.add(reconstruction)
        db.commit()
        job_id, reconstruction_id = job.id, reconstruction.id
    with TestClient(app) as client:
        initial = client.get(f"/v1/jobs/{job_id}/events", headers=accounts["owner"]["headers"])
        assert initial.status_code == 200
        ids = [line[4:] for line in initial.text.splitlines() if line.startswith("id: ")]
        assert len(ids) == 2
        response = client.get(
            f"/v1/jobs/{job_id}/events", params={"lastEventId": ids[0]}, headers=accounts["owner"]["headers"]
        )
        assert response.status_code == 200
        assert f"id: {ids[0]}\n" not in response.text and f"id: {ids[1]}\n" in response.text
        final = next(block for block in response.text.split("\n\n") if block.startswith("event: final"))
        assert (
            json.loads(next(line[6:] for line in final.splitlines() if line.startswith("data: ")))["reconstruction_id"]
            == reconstruction_id
        )
