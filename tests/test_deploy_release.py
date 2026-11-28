"""Exercise release ordering and identity without contacting a deployment host."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import pytest

from scripts import deploy_release as release

COMMIT = "a" * 40
STAGE = "/root/rescene-stage-0.6.0-AbCd1234"
ROOT = Path(__file__).resolve().parents[1]


def arguments() -> argparse.Namespace:
    return argparse.Namespace(version="0.6.0", tag="v0.6.0", repo="FLmhp/ReScene", commit=COMMIT, run_url="")


class FakeRemote:
    def __init__(self, recorder: release.Recorder, key: str, known_hosts: str) -> None:
        self.calls: list[tuple[str, str]] = []
        self.revision = "0011"
        self.head = "0012"
        self.fail_health = False

    def run(self, name: str, script: str, timeout: int = 600) -> str:
        self.calls.append((name, script))
        if name == "allocate-stage":
            return STAGE
        if name.startswith("image-"):
            return "sha256:" + "a" * 64
        if name == "backup":
            return "backup=/protected/backup\ndump=/protected/dump\ndump_sha256=abc"
        return ""

    def read(self, name: str, script: str, timeout: int = 120) -> str:
        self.calls.append((name, script))
        if name == "db-revision-before":
            return self.revision
        if name == "db-revision-after":
            return self.head
        if name == "health-api" and self.fail_health:
            raise release.DeployError("unhealthy API")
        return "healthy"

    def put(self, name: str, path: str, content: str) -> None:
        self.calls.append((name, path))


@pytest.fixture
def deployment(monkeypatch: pytest.MonkeyPatch) -> tuple[FakeRemote, release.Recorder, argparse.Namespace]:
    recorder = release.Recorder("0.6.0", "v0.6.0", "example")
    remote = FakeRemote(recorder, "", "")
    monkeypatch.setattr(release, "Remote", lambda *_: remote)
    monkeypatch.setattr(release, "probe", lambda name, method, url, expected, body: {"name": name, "ok": True})
    return remote, recorder, arguments()


def test_deploy_uses_unique_stage_commit_and_safe_order(deployment: tuple) -> None:
    remote, recorder, args = deployment
    release.deploy(recorder, ROOT, args, "", "")
    scripts = dict(remote.calls)
    names = [name for name, _ in remote.calls]
    assert "mktemp -d /root/rescene-stage-0.6.0-XXXXXXXX" in scripts["allocate-stage"]
    assert f"https://codeload.github.com/FLmhp/ReScene/tar.gz/{COMMIT}" in scripts["stage-source"]
    assert "refs/tags" not in scripts["stage-source"]
    assert all("prune" not in script and "rm -rf" not in script for _, script in remote.calls)
    assert all(f"cd {STAGE}" in scripts[f"build-{service}"] for service in ("api", "web"))
    assert "cmp -s" in scripts["check-config"]
    assert "config --quiet" in scripts["check-config"]
    assert 'mkdir -m 700 "$backup"' in scripts["backup"]
    assert 'chmod 600 "$backup/env"' in scripts["backup"]
    assert names.index("check-config") < names.index("up-api")
    assert (
        names.index("db-revision-before")
        < names.index("up-api")
        < names.index("health-api")
        < names.index("db-revision-after")
        < names.index("up-web")
    )


def test_migration_mismatch_never_switches_services(deployment: tuple) -> None:
    remote, recorder, args = deployment
    remote.revision = "9999"
    with pytest.raises(release.DeployError, match="migration path"):
        release.deploy(recorder, ROOT, args, "", "")
    assert not any(name.startswith("up-") for name, _ in remote.calls)


def test_api_must_apply_release_migration(deployment: tuple) -> None:
    remote, recorder, args = deployment
    remote.head = "0011"
    with pytest.raises(release.DeployError, match="db-revision-after"):
        release.deploy(recorder, ROOT, args, "", "")
    assert "up-api" in [name for name, _ in remote.calls]
    assert "up-web" not in [name for name, _ in remote.calls]


def test_unhealthy_api_never_switches_web(deployment: tuple) -> None:
    remote, recorder, args = deployment
    remote.fail_health = True
    with pytest.raises(release.DeployError, match="unhealthy API"):
        release.deploy(recorder, ROOT, args, "", "")
    assert "up-api" in [name for name, _ in remote.calls]
    assert "up-web" not in [name for name, _ in remote.calls]


def test_invalid_allocated_stage_never_used(deployment: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    remote, recorder, args = deployment
    original = remote.run
    monkeypatch.setattr(
        remote,
        "run",
        lambda name, script, timeout=600: (
            "/root/other" if name == "allocate-stage" else original(name, script, timeout)
        ),
    )
    with pytest.raises(release.DeployError, match="unexpected path"):
        release.deploy(recorder, ROOT, args, "", "")
    assert "stage-source" not in [name for name, _ in remote.calls]


def test_checkout_identity_and_dirty_migrations(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "VERSION").write_text("0.6.0\n", encoding="utf-8")
    args = arguments()
    state = {"head": COMMIT, "status": ""}

    def fake_git(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        operation = command[3]
        output = (
            str(tmp_path)
            if operation == "rev-parse" and command[4] == "--show-toplevel"
            else (state["head"] if operation == "rev-parse" else state["status"])
        )
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    monkeypatch.setattr(release.subprocess, "run", fake_git)
    release.validate_checkout(tmp_path, args)
    state["head"] = "b" * 40
    with pytest.raises(release.DeployError, match="checkout HEAD"):
        release.validate_checkout(tmp_path, args)
    state["head"] = COMMIT
    state["status"] = "?? src/rescene_api/migrations/versions/v_new.py"
    with pytest.raises(release.DeployError, match="migrations differ"):
        release.validate_checkout(tmp_path, args)
    state["status"] = ""
    for commit in ("A" * 40, "a" * 39, "a" * 41):
        args.commit = commit
        with pytest.raises(release.DeployError, match="lowercase"):
            release.validate_checkout(tmp_path, args)
    args.commit = COMMIT
    args.tag = "v0.5.1"
    with pytest.raises(release.DeployError, match="tag"):
        release.validate_checkout(tmp_path, args)
