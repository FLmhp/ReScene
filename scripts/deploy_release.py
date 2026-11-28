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
import shlex
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
            "dbRevisionBefore": None,
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
    """One SSH client; each call runs a bash script passed as an argument.

    The script must not arrive on stdin: `docker compose exec` inherits the
    shell's stdin and would swallow the rest of the script when it does.
    """

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
        ]  # fmt: skip

    def run(self, name: str, script: str, timeout: int = 600) -> str:
        return self.exec(name, "set -euo pipefail\n" + script, timeout)

    def read(self, name: str, script: str, timeout: int = 120) -> str:
        """Run a command whose failure is reported, not raised."""
        return self.exec(name, "set -uo pipefail\n" + script, timeout)

    def exec(self, name: str, script: str, timeout: int) -> str:
        started = now()
        try:
            done = subprocess.run(  # noqa: S603 - fixed binary, the script is one quoted argument
                [*self.base, "bash", "-c", shlex.quote(script)],
                stdin=subprocess.DEVNULL,
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


def migrations(root: Path) -> dict[str, str | None]:
    """Read revision -> down_revision for every migration in the checked-out source."""
    versions = root / "src/rescene_api/migrations/versions"
    chain: dict[str, str | None] = {}
    for path in sorted(versions.glob("v*.py")):
        text = path.read_text(encoding="utf-8")
        revision = re.search(r'^revision = "([^"]+)"', text, re.M)
        if revision is None:
            raise DeployError(f"no revision in {path.name}")
        down = re.search(r'^down_revision = ("([^"]+)"|None)$', text, re.M)
        if down is None:
            raise DeployError(f"no down_revision in {path.name}")
        chain[revision.group(1)] = down.group(2)
    return chain


def migration_head(root: Path) -> str:
    """Resolve the alembic head the checked-out source would apply."""
    chain = migrations(root)
    heads = set(chain) - {parent for parent in chain.values() if parent is not None}
    if len(heads) != 1:
        raise DeployError(f"expected one migration head, found {sorted(heads)}")
    return heads.pop()


def migration_covers(root: Path, current: str, head: str) -> bool:
    """Return whether applying `head` upgrades `current` without a schema branch."""
    chain = migrations(root)
    revision: str | None = head
    while revision is not None:
        if revision == current:
            return True
        revision = chain.get(revision)
    return False


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
        if last == "healthy":
            return last
        time.sleep(3)
    raise DeployError(f"rescene-{service} was {last} after {HEALTH_TIMEOUT}s")


def fill(script: str, **values: str) -> str:
    for key, value in values.items():
        script = script.replace(f"@@{key}@@", value)
    return script


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

BUILD = {
    "api": "docker build -f infra/api/Dockerfile -t 'rescene-api:@@VERSION@@' .",
    "web": (
        "docker build -f infra/web/Dockerfile "
        "--build-arg NEXT_PUBLIC_API_URL=https://api.rescene.xyz "
        "-t 'rescene-web:@@VERSION@@' ."
    ),
}


def build_image(remote: Remote, service: str, version: str, stage: str) -> str:
    """Build one service image and read back its digest.

    The build log interleaves base-image digests with the layers, so the image
    identity comes from a separate inspect rather than from that output.
    """
    remote.run(
        f"build-{service}",
        f"cd {shlex.quote(stage)}\n" + fill(BUILD[service], VERSION=version) + "\n",
        1800,
    )
    digest = remote.run(
        f"image-{service}",
        f"docker image inspect --format '{{{{.Id}}}}' 'rescene-{service}:{version}'\n",
    ).strip()
    if not DIGEST.match(digest):
        raise DeployError(f"image-{service}: unexpected image id {digest!r}")
    return digest


def deploy(recorder: Recorder, root: Path, args: argparse.Namespace, key: str, known_hosts: str) -> None:
    remote = Remote(recorder, key, known_hosts)
    tokens = {"VERSION": args.version, "COMMIT": args.commit, "REPO": args.repo}

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

    stage = remote.run("allocate-stage", f"mktemp -d /root/rescene-stage-{args.version}-XXXXXXXX\n").strip()
    if not re.fullmatch(rf"/root/rescene-stage-{re.escape(args.version)}-[A-Za-z0-9]{{8}}", stage):
        raise DeployError(f"allocate-stage: unexpected path {stage!r}")
    tokens["STAGE"] = stage
    remote.run(
        "stage-source",
        fill(
            """
curl -fsSL --retry 3 --retry-delay 5 --max-time 600 \
  "https://codeload.github.com/@@REPO@@/tar.gz/@@COMMIT@@" \
  | tar -xz -C "@@STAGE@@" --strip-components=1
test -f "@@STAGE@@/VERSION"
grep -qx '@@VERSION@@' "@@STAGE@@/VERSION" || { echo 'Staged VERSION is not @@VERSION@@' >&2; exit 3; }
echo "staged $(cat "@@STAGE@@/VERSION")"
""",
            **tokens,
        ),
    )
    remote.run(
        "check-config",
        fill(
            """
cmp -s "@@STAGE@@/infra/compose.yaml" "@@INFRA@@/compose.yaml" || { echo 'Compose configuration drift' >&2; exit 3; }
@@COMPOSE@@ config --quiet
""",
            INFRA=INFRA,
            COMPOSE=COMPOSE,
            **tokens,
        ),
    )

    api_id = build_image(remote, "api", args.version, stage)
    recorder.summary["images"] = {"api": api_id}
    web_id = build_image(remote, "web", args.version, stage)
    recorder.summary["images"] = {"api": api_id, "web": web_id}

    backup = remote.run(
        "backup",
        fill(
            """
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/root/rescene-backup-@@VERSION@@-$stamp"
umask 077
mkdir -m 700 "$backup"
cp "@@INFRA@@/.env" "$backup/env"
chmod 600 "$backup/env"
cp "@@INFRA@@/compose.yaml" "$backup/compose.yaml"
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
    # A deploy without a verified snapshot must not reach the release log.
    missing = [k for k in ("backupDir", "dumpPath", "dumpSha256") if not recorder.summary[k]]
    if missing:
        raise DeployError(f"backup: the snapshot was not recorded ({', '.join(missing)})")

    before = remote.read(
        "db-revision-before",
        fill(
            """
@@COMPOSE@@ exec -T db psql -U rescene -tAc 'select version_num from alembic_version'
""",
            COMPOSE=COMPOSE,
        ),
    ).strip()
    recorder.summary["dbRevisionBefore"] = before
    head = str(recorder.summary["dbRevision"])
    if not migration_covers(root, before, head):
        recorder.step("db-revision-before", False, f"{before} does not reach {head}")
        raise DeployError("db-revision-before: database is not on the release migration path")
    recorder.step("db-revision-before", True, f"{before} -> {head}")

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
        if service == "api":
            # API startup applies migrations. The upgraded schema must be visible
            # before web starts; a different revision is a failed release.
            revision = remote.read(
                "db-revision-after",
                fill(
                    """
@@COMPOSE@@ exec -T db psql -U rescene -tAc 'select version_num from alembic_version'
""",
                    COMPOSE=COMPOSE,
                ),
            ).strip()
            if revision != head:
                recorder.step("db-revision-after", False, f"expected {head}, found {revision}")
                raise DeployError("db-revision-after: API did not apply the release migration")
            recorder.step("db-revision-after", True, revision)

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


def validate_checkout(root: Path, args: argparse.Namespace) -> None:
    """Reject ambiguous release identities before contacting the host."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version) or args.tag != f"v{args.version}":
        raise DeployError("tag must match a numeric VERSION")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise DeployError("invalid repository name")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise DeployError("commit must be a full lowercase SHA-1")
    try:

        def git(*arguments: str) -> str:
            return subprocess.run(
                ["git", "-C", str(root), *arguments],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()

        if Path(git("rev-parse", "--show-toplevel")).resolve() != root:
            raise DeployError("root must be the checkout root")
        if git("rev-parse", "HEAD") != args.commit:
            raise DeployError("commit does not match checkout HEAD")
        if git(
            "status", "--porcelain", "--untracked-files=all", "--", "VERSION", "src/rescene_api/migrations/versions"
        ):
            raise DeployError("VERSION or migrations differ from the checkout")
        if (root / "VERSION").read_text(encoding="utf-8").strip() != args.version:
            raise DeployError("VERSION does not match release version")
    except (OSError, subprocess.CalledProcessError) as error:
        raise DeployError(f"cannot verify checkout: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, for example v0.5.1")
    parser.add_argument("--version", required=True, help="VERSION value the tag must match")
    parser.add_argument("--repo", required=True, help="owner/name used to fetch the release source")
    parser.add_argument(
        "--root",
        default="",
        help="checkout that supplies VERSION and the migrations of the deployed tag",
    )
    parser.add_argument("--commit", required=True, help="full checkout commit to deploy")
    parser.add_argument("--run-url", default="")
    parser.add_argument("--log", default="deploy-log.json")
    args = parser.parse_args()
    args.run_url = args.run_url or (
        f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
        f"{args.repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    )

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    try:
        validate_checkout(root, args)
    except DeployError as error:
        print(f"Invalid release: {error}", file=sys.stderr)
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
