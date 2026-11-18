"""Repeat API/role checks and a database restore against a disposable PostgreSQL."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

FIXTURE_PASSWORD = "offline-fixture-password"
EMAIL = "offline-owner@example.test"
PROJECT = "offline-restore-fixture"


def verify_database(phase: str) -> dict:
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from rescene_api.db import engine
    from rescene_api.main import app

    with engine.connect() as connection:
        if phase == "restored":
            # Verify the dump before the application starts its migration hook.
            revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    with TestClient(app) as client:
        users = {}
        for role, address in (
            ("owner", EMAIL),
            ("viewer", "offline-viewer@example.test"),
            ("outsider", "offline-outsider@example.test"),
        ):
            credentials = {"email": address, "password": FIXTURE_PASSWORD}
            if phase == "source":
                client.post("/v1/auth/register", json=credentials).raise_for_status()
            login = client.post("/v1/auth/login", json=credentials)
            login.raise_for_status()
            users[role] = {"Authorization": "Bearer " + login.json()["access_token"]}
        headers = users["owner"]
        if phase == "source":
            client.post("/v1/projects", headers=headers, json={"name": PROJECT}).raise_for_status()
        projects = client.get("/v1/projects", headers=headers)
        projects.raise_for_status()
        items = projects.json()
        assert len(items) == 1 and items[0]["name"] == PROJECT and items[0]["effective_role"] == "owner"
        path = f"/v1/projects/{items[0]['id']}"
        if phase == "source":
            client.post(
                path + "/members", headers=headers, json={"email": "offline-viewer@example.test", "role": "viewer"}
            ).raise_for_status()
        viewer = users["viewer"]
        assert client.get(path, params={"view": "summary"}, headers=viewer).json()["effective_role"] == "viewer"
        for route in (path, path + "/assets", path + "/jobs"):
            assert client.get(route, headers=viewer).status_code == 200
            assert client.get(route, headers=users["outsider"]).status_code == 403
        assert client.patch(path, headers=viewer, json={"name": "denied"}).status_code == 403
    with engine.connect() as connection:
        current = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    if phase == "restored":
        assert current == revision
    return {"project_id": items[0]["id"], "alembic": current}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".cache/offline-verification.json"))
    parser.add_argument("--build-clients", action="store_true")
    args = parser.parse_args()
    docker = shutil.which("docker")
    pnpm = shutil.which("pnpm")
    if not docker or not pnpm:
        raise SystemExit("Docker and pnpm must be available on PATH")

    def run(*command: str, capture: bool = False, env: dict | None = None) -> str:
        return (
            subprocess.run(
                command,
                check=True,
                text=True,
                stdout=subprocess.PIPE if capture else None,
                env=env,
            ).stdout
            or ""
        )

    env = os.environ.copy()
    env["PATH"] = os.pathsep.join((str(Path(sys.executable).parent), env["PATH"]))
    name = f"rescene-offline-{uuid4().hex[:12]}"
    container = run(
        docker,
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-p",
        "127.0.0.1::5432",
        "-e",
        f"POSTGRES_PASSWORD={FIXTURE_PASSWORD}",
        "-e",
        "POSTGRES_DB=rescene_test",
        "postgres:16-alpine",
        capture=True,
    ).strip()
    try:
        target = run(docker, "port", container, "5432/tcp", capture=True).strip()
        for _ in range(30):
            ready = subprocess.run(
                [docker, "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "rescene_test"],
                stdout=subprocess.DEVNULL,
            )
            if not ready.returncode:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Disposable PostgreSQL did not start")
        base = f"postgresql+psycopg://postgres:{FIXTURE_PASSWORD}@{target}/"
        env.update(
            RESCENE_TEST_POSTGRES_URL=base + "rescene_test", RESCENE_JWT_SECRET="offline-test-signing-secret-32-bytes"
        )
        run(pnpm, "quality", env=env)

        def probe(phase: str, database: str) -> dict:
            helper = (
                "import json,sys; from scripts.verify_offline import verify_database; "
                "print(json.dumps(verify_database(sys.argv[1])))"
            )
            return json.loads(
                run(
                    sys.executable,
                    "-c",
                    helper,
                    phase,
                    env={**env, "RESCENE_DATABASE_URL": base + database},
                    capture=True,
                )
            )

        seeded = probe("source", "rescene_test")
        run(docker, "exec", container, "pg_dump", "-U", "postgres", "-Fc", "-f", "/tmp/rescene.dump", "rescene_test")
        run(docker, "exec", container, "createdb", "-U", "postgres", "rescene_restore")
        run(
            docker,
            "exec",
            container,
            "pg_restore",
            "-U",
            "postgres",
            "--exit-on-error",
            "-d",
            "rescene_restore",
            "/tmp/rescene.dump",
        )
        restored = probe("restored", "rescene_restore")
        if seeded != restored:
            raise RuntimeError("Restored project or migration revision differs")
        digest = run(docker, "exec", container, "sha256sum", "/tmp/rescene.dump", capture=True).split()[0]
        sql = Path("infra/deploy/health_snapshot.sql").read_text(encoding="utf-8")
        snapshot = json.loads(
            subprocess.run(
                [
                    docker,
                    "exec",
                    "-i",
                    container,
                    "psql",
                    "-qAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    "rescene_restore",
                ],
                input=sql,
                text=True,
                capture_output=True,
                check=True,
            ).stdout
        )
        assert snapshot["queued"] == snapshot["active"] == 0
    finally:
        run(docker, "stop", container)
    result = {
        "quality": "pass",
        "postgres_restore": {"status": "pass", "dump_sha256": digest, **restored},
        "operational_snapshot": snapshot,
    }
    if args.build_clients:
        for package, task in (
            ("rescene-web", "build"),
            ("@rescene/desktop", "build"),
            ("@rescene/mobile", "export"),
            ("@rescene/miniapp", "build:weapp"),
        ):
            run(
                pnpm,
                "--filter",
                package,
                task,
                env={
                    **env,
                    "TARO_APP_API_URL": "https://api.example.com",
                    "TARO_APP_WEB_URL": "https://app.example.com",
                    "TARO_APP_WECHAT_APP_ID": "wx0123456789abcdef",
                },
            )
        run("node", "scripts/check-miniapp-login.mjs", env=env)
        result["client_builds"] = "pass"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
