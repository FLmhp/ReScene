#!/usr/bin/env python3
"""Deploy a released tag to the production host and record every step.

The release workflow builds the installers on GitHub-hosted runners, then runs
this script to rebuild the two service images on the production host itself,
snapshot the database, swap `api` and `web`, and probe the public edge. Each
step is appended to `deploy-log.json`, which the workflow uploads as release
evidence: a partially applied deploy must stay auditable.

Nothing is rolled back automatically. The previous images and a `pg_dump` are
recorded so a human can recover, because a database migration is not undone by
restoring an image.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

REMOTE_ROOT = "/opt/rescene"
INFRA = f"{REMOTE_ROOT}/infra"
COMPOSE = f"docker compose --project-directory {INFRA} --env-file {INFRA}/.env -f {INFRA}/compose.yaml"
API_URL = "https://api.rescene.xyz"
WEB_URL = "https://app.rescene.xyz"
MIN_FREE_BYTES = 8 * 1024**3
HEALTH_TIMEOUT = 120


class DeployError(RuntimeError):
    """A recorded step failed; the log already names the step and its output."""


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Recorder:
    """Append-only step log that survives a failure part-way through."""

    def __init__(self, version: str, tag: str, host: str) -> None:
        self.version = version
        self.tag = tag
        self.host = host
        self.steps: list[dict[str, object]] = []
        self.summary: dict[str, object] = {
            "images": {},
            "dbRevision": None,
            "dumpPath": None,
            "dumpSha256": None,
            "backupDir": None,
            "probes": [],
        }
        self.failed: str | None = None

    def step(self, name: str, ok: bool, output: str) -> None:
        self.steps.append({"step": name, "at": now(), "ok": ok, "outputTail": output[-4000:]})
        if not ok and self.failed is None:
            self.failed = name

    def payload(self, commit: str, run_url: str) -> dict[str, object]:
        return {
            "schema": 1,
            "version": self.version,
            "tag": self.tag,
            "commit": commit,
            "runUrl": run_url,
            "host": self.host,
            "generatedAt": now(),
            "ok": self.failed is None,
            "failedStep": self.failed,
            "steps": self.steps,
            "deploy": self.summary,
        }


class Remote:
    """One SSH client; every call runs a bash script on stdin."""

    def __init__(self, recorder: Recorder, key: str, known_hosts: str) -> None:
        host = os.environ["DEPLOY_HOST"]
        user = os.environ.get("DEPLOY_USER", "root")
        port = os.environ.get("DEPLOY_PORT", "22")
        self.dest = f"{user}@{host}"
        self.recorder = recorder
        self.base = [
            "ssh",
            "-i", key,
            "-p", port,
            "-o", f"UserKnownHostsFile={known_hosts}",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=20",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=6",
            self.dest,
            "bash", "-s",
        ]  # fmt: skip

    def run(self, name: str, script: str, timeout: int = 600) -> str:
        return self.exec(name, "set -euo pipefail\n" + script, timeout)

    def read(self, name: str, script: str, timeout: int = 120) -> str:
        """Run a command whose failure is reported, not raised."""
        return self.exec(name, "set -uo pipefail\n" + script, timeout)

    def exec(self, name: str, script: str, timeout: int) -> str:
        started = now()
        try:
            done = subprocess.run(  # noqa: S603 - fixed binary, arguments are not shell-interpreted
                self.base,
                input=script.encode(),
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self.recorder.step(name, False, f"timed out after {timeout}s (started {started})")
            raise DeployError(f"{name}: timed out after {timeout}s") from None
        output = (done.stdout + done.stderr).decode("utf-8", "replace").strip()
        self.recorder.step(name, done.returncode == 0, output)
        if done.returncode != 0:
            raise DeployError(f"{name}: exit {done.returncode}")
        return output

    def put(self, name: str, path: str, content: str) -> None:
        """Write a remote file from a base64 payload, so quoting cannot bite."""
        encoded = base64.b64encode(content.encode()).decode()
        self.run(name, f'mkdir -p "$(dirname {path})"\nprintf %s {encoded} | base64 -d > {path}\n')


def migration_head(root: Path) -> str:
    """Resolve the alembic head the checked-out source would apply."""
    versions = root / "src/rescene_api/migrations/versions"
    revisions: set[str] = set()
    parents: set[str] = set()
    for path in sorted(versions.glob("v*.py")):
        text = path.read_text(encoding="utf-8")
        revision = re.search(r'^revision = "([^"]+)"', text, re.M)
        if revision is None:
            raise DeployError(f"no revision in {path.name}")
        revisions.add(revision.group(1))
        down = re.search(r'^down_revision = ("([^"]+)"|None)$', text, re.M)
        if down is None:
            raise DeployError(f"no down_revision in {path.name}")
        if down.group(2) is not None:
            parents.add(down.group(2))
    heads = revisions - parents
    if len(heads) != 1:
        raise DeployError(f"expected one migration head, found {sorted(heads)}")
    return heads.pop()


def probe(name: str, method: str, url: str, expected: int, body: dict[str, str] | None) -> dict[str, object]:
    """Hit the public edge with no credentials, so auth stays untested by policy."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    except (urllib.error.URLError, TimeoutError) as error:
        return {"name": name, "url": url, "expected": expected, "actual": None, "ok": False, "error": str(error)}
    return {"name": name, "url": url, "expected": expected, "actual": status, "ok": status == expected}


def wait_healthy(remote: Remote, service: str) -> str:
    """Poll the container health status; `up -d` returns before the app is ready."""
    deadline = time.monotonic() + HEALTH_TIMEOUT
    last = "unknown"
    while time.monotonic() < deadline:
        last = remote.read(
            f"health-{service}",
            "docker inspect --format "
            f"'{{{{if .State.Health}}}}{{{{.State.Health.Status}}}}{{{{else}}}}{{{{.State.Status}}}}{{{{end}}}}' "
            f"rescene-{service} 2>/dev/null || echo missing\n",
        )
        if last in {"healthy", "running"}:
            return last
        time.sleep(3)
    raise DeployError(f"rescene-{service} was {last} after {HEALTH_TIMEOUT}s")


def fill(script: str, **values: str) -> str:
    for key, value in values.items():
        script = script.replace(f"@@{key}@@", value)
    return script


def deploy(recorder: Recorder, root: Path, args: argparse.Namespace, key: str, known_hosts: str) -> None:
    remote = Remote(recorder, key, known_hosts)
    stage = f"/root/rescene-stage-{args.version}"
    tokens = {"VERSION": args.version, "TAG": args.tag, "REPO": args.repo, "STAGE": stage}

    recorder.summary["dbRevision"] = migration_head(root)

    out = remote.run(
        "disk-before",
        fill(
            """
df -h /
avail=$(df -P -B1 / | tail -n1 | awk '{print $4}')
echo "avail_bytes=$avail"
[ "$avail" -ge @@MIN@@ ] || { echo "Only $avail bytes free on /" >&2; exit 3; }
""",
            MIN=str(MIN_FREE_BYTES),
            **tokens,
        ),
    )
    print(out)

    remote.run(
        "stage-source",
        fill(
            """
rm -rf "@@STAGE@@"; mkdir -p "@@STAGE@@"
curl -fsSL --retry 3 --retry-delay 5 --max-time 600 \
  "https://codeload.github.com/@@REPO@@/tar.gz/refs/tags/@@TAG@@" \
  | tar -xz -C "@@STAGE@@" --strip-components=1
test -f "@@STAGE@@/VERSION"
grep -qx '@@VERSION@@' "@@STAGE@@/VERSION" || { echo 'Staged VERSION is not @@VERSION@@' >&2; exit 3; }
echo "staged $(cat "@@STAGE@@/VERSION")"
""",
            **tokens,
        ),
    )

    remote.run("docker-prune", "docker builder prune -f\n")

    api_id = remote.run(
        "build-api",
        fill(
            """
cd "@@STAGE@@"
docker build -f infra/api/Dockerfile -t "rescene-api:@@VERSION@@" .
docker image inspect --format '{{.Id}}' "rescene-api:@@VERSION@@"
""",
            **tokens,
        ),
        1800,
    ).strip()
    recorder.summary["images"] = {"api": api_id}

    web_id = remote.run(
        "build-web",
        fill(
            """
cd "@@STAGE@@"
docker build -f infra/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.rescene.xyz -t "rescene-web:@@VERSION@@" .
docker image inspect --format '{{.Id}}' "rescene-web:@@VERSION@@"
""",
            **tokens,
        ),
        1800,
    ).strip()
    recorder.summary["images"] = {"api": api_id, "web": web_id}

    backup = remote.run(
        "backup",
        fill(
            """
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/root/rescene-backup-@@VERSION@@-$stamp"
install -d -m 750 "$backup"
cp -a "@@INFRA@@/.env" "$backup/env"
cp -a "@@INFRA@@/compose.yaml" "$backup/compose.yaml"
{ docker inspect --format '{{.Name}} {{.Image}}' rescene-api rescene-web rescene-db; } > "$backup/before-images.txt"
install -d -m 750 -o root -g 65532 "@@INFRA@@/backups"
dump="@@INFRA@@/backups/rescene-pre-deploy-@@VERSION@@-$stamp.dump"
[ ! -e "$dump" ] || { echo "Pre-deploy dump already exists: $dump" >&2; exit 4; }
umask 077
partial=$(mktemp "@@INFRA@@/backups/.rescene-pre-deploy-XXXXXXXX.dump")
trap 'rm -f -- "$partial"' 0
@@COMPOSE@@ exec -T db pg_dump -U rescene -Fc rescene > "$partial"
test -s "$partial"
@@COMPOSE@@ exec -T db pg_restore --list < "$partial" > /dev/null
chgrp 65532 "$partial"; chmod 640 "$partial"
mv "$partial" "$dump"
trap - 0
umask 022
printf 'backup=%s\\ndump=%s\\ndump_sha256=%s\\n' "$backup" "$dump" "$(sha256sum "$dump" | cut -d' ' -f1)"
""",
            INFRA=INFRA,
            COMPOSE=COMPOSE,
            **tokens,
        ),
        900,
    )
    for line in backup.splitlines():
        key_name, _, value = line.partition("=")
        if key_name == "backup":
            recorder.summary["backupDir"] = value
        elif key_name == "dump":
            recorder.summary["dumpPath"] = value
        elif key_name == "dump_sha256":
            recorder.summary["dumpSha256"] = value

    for service in ("api", "web"):
        remote.run(
            f"up-{service}",
            fill(
                f"""
docker tag "rescene-{service}:@@VERSION@@" "rescene-{service}:latest"
@@COMPOSE@@ up -d --no-deps --no-build {service}
""",
                COMPOSE=COMPOSE,
                **tokens,
            ),
            600,
        )
        wait_healthy(remote, service)

    revision = remote.read(
        "db-revision",
        fill(
            """
@@COMPOSE@@ exec -T db psql -U rescene -tAc 'select version_num from alembic_version'
""",
            COMPOSE=COMPOSE,
        ),
    ).strip()
    if revision != recorder.summary["dbRevision"]:
        recorder.step("db-revision", False, f"expected {recorder.summary['dbRevision']}, found {revision}")
        raise DeployError("db-revision: alembic_version does not match the source head")

    probes = [
        probe("api-ready", "GET", f"{API_URL}/health/ready", 200, None),
        probe("web-root", "GET", f"{WEB_URL}/", 200, None),
        probe("email-code-accepted", "POST", f"{API_URL}/v1/auth/email-code", 202,
              {"email": "deploy-probe@rescene.invalid", "purpose": "login"}),
        probe("login-rejected", "POST", f"{API_URL}/v1/auth/login", 401,
              {"email": "deploy-probe@rescene.invalid", "password": "not-a-real-password"}),
    ]  # fmt: skip
    recorder.summary["probes"] = probes
    rendered = json.dumps(probes, indent=2)
    recorder.step("probes", all(p["ok"] for p in probes), rendered)
    if not all(p["ok"] for p in probes):
        raise DeployError("probes: the public edge did not answer as expected")

    status = json.dumps(
        {k: v for k, v in recorder.payload(args.commit, args.run_url).items() if k != "steps"}, indent=2
    )
    remote.put("record-status", f"{REMOTE_ROOT}/releases/{args.version}/status.json", status + "\n")
    remote.run("disk-after", "df -h /\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, for example v0.5.1")
    parser.add_argument("--version", required=True, help="VERSION value the tag must match")
    parser.add_argument("--repo", required=True, help="owner/name used to fetch the release source")
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument("--run-url", default="")
    parser.add_argument("--log", default="deploy-log.json")
    args = parser.parse_args()
    args.run_url = args.run_url or (
        f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
        f"{args.repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    )

    root = Path(__file__).resolve().parent.parent
    if (root / "VERSION").read_text(encoding="utf-8").strip() != args.version:
        print(f"VERSION is not {args.version}", file=sys.stderr)
        return 2

    required = ["DEPLOY_KEY_FILE", "DEPLOY_KNOWN_HOSTS_FILE", "DEPLOY_HOST"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"Missing environment: {', '.join(missing)}", file=sys.stderr)
        return 2
    key = os.environ["DEPLOY_KEY_FILE"]
    known_hosts = os.environ["DEPLOY_KNOWN_HOSTS_FILE"]

    recorder = Recorder(args.version, args.tag, os.environ["DEPLOY_HOST"])
    status = 0
    try:
        deploy(recorder, root, args, key, known_hosts)
    except DeployError as error:
        print(f"Deploy failed: {error}", file=sys.stderr)
        print("No automatic rollback; the completed steps and backup path are in the log.", file=sys.stderr)
        status = 1

    Path(args.log).write_text(
        json.dumps(recorder.payload(args.commit, args.run_url), indent=2) + "\n", encoding="utf-8"
    )
    return status


if __name__ == "__main__":
    sys.exit(main())
