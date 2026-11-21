"""Rehearse ``scripts/deploy_targeted.sh`` against shell-function stubs.

The script talks to a production host, so every external command is replaced by
a stub that records its arguments. Stubs are injected through ``BASH_ENV``
because functions take precedence over PATH lookups in Git Bash. The tests assert
phase order, which services a failed run restores, and the non-zero exits that
guard the database.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[1]
VERSION = "0.4.1"

STUB_ENV = """\
log() { printf '%s %s\\n' "$1" "$(printf '%s' "$2" | tr '\\n' ' ' | tr -s ' ')" >> "$STUB_LOG"; }
ssh() {
  log ssh "$*"
  case "$*" in
    *"ps -q api"*) printf 'api-container-id\\n' ;;
    *"ps -q web"*) printf 'web-container-id\\n' ;;
    *"State.Health"*)
      case "$*" in
        *web-container-id*) printf '%s\\n' "${STUB_HEALTH_WEB:-healthy}" ;;
        *) printf '%s\\n' "${STUB_HEALTH_API:-healthy}" ;;
      esac ;;
    *"docker load"*) [ "${STUB_LOAD_OK:-1}" = 1 ] || return 1 ;;
    *"docker tag"*before-images.txt*) [ "${STUB_RESTORE_FAIL:-0}" = 1 ] && return 1 ;;
  esac
  return 0
}
docker() {
  log docker "$*"
  case "$*" in
    image\\ inspect*) printf 'sha256:local-candidate\\n' ;;
    inspect*) printf '/rescene-api sha256:previous-api\\n' ;;
  esac
  return 0
}
scp() { log scp "$*"; }
node() { log node "$*"; }
gzip() { log gzip "$*"; }
sleep() { log sleep "$*"; }
seq() {
  log seq "$*"
  [ "${STUB_SINGLE_PROBE:-0}" = 1 ] && { printf '1\\n'; return 0; }
  command seq "$@"
}
curl() {
  log curl "$*"
  [ "${STUB_CURL_FAIL:-0}" = 1 ] && return 22
  return 0
}
"""


def bash_candidates() -> list[str]:
    override = os.environ.get("RESCENE_BASH")
    candidates = [override] if override else []
    candidates.append(shutil.which("bash"))
    git = shutil.which("git")
    if git:
        exec_path = subprocess.run([git, "--exec-path"], capture_output=True, text=True, errors="replace")
        if exec_path.returncode == 0:
            root = Path(exec_path.stdout.strip()).parents[2]
            candidates += [str(root / "bin" / "bash.exe"), str(root / "usr" / "bin" / "bash.exe")]
    candidates += ["/bin/bash", "/usr/bin/bash", r"C:\Program Files\Git\bin\bash.exe"]
    return [candidate for candidate in candidates if candidate]


def is_wsl_launcher(path: str) -> bool:
    lowered = path.lower().replace("/", "\\")
    return "windowsapps" in lowered or lowered.endswith("system32\\bash.exe")


def find_bash() -> str | None:
    for candidate in dict.fromkeys(bash_candidates()):
        if is_wsl_launcher(candidate) or not Path(candidate).is_file():
            continue
        probe = subprocess.run([candidate, "-c", "echo probe-ok"], capture_output=True, text=True, errors="replace")
        if probe.returncode == 0 and "probe-ok" in probe.stdout:
            return candidate
    return None


BASH = find_bash()
pytestmark = pytest.mark.skipif(BASH is None, reason="the deploy script needs a working bash")


def posix_path(path: Path) -> str:
    if os.name != "nt":
        return str(path)
    drive_path = path.as_posix()
    return f"/{drive_path[0].lower()}{drive_path[2:]}"


def run_script(tmp_path: Path, **extra_env: str) -> subprocess.CompletedProcess[str]:
    root = tmp_path / "deploy-root"
    (root / "scripts").mkdir(parents=True)
    (root / "VERSION").write_text(f"{VERSION}\n", encoding="utf-8", newline="\n")
    shutil.copy(REPO_ROOT / "scripts/deploy_targeted.sh", root / "scripts/deploy_targeted.sh")
    log = tmp_path / "calls.log"
    log.write_text("", encoding="utf-8")
    stub_env = tmp_path / "stub-env.sh"
    stub_env.write_text(STUB_ENV, encoding="utf-8", newline="\n")
    env = {
        **os.environ,
        "BASH_ENV": posix_path(stub_env),
        "STUB_LOG": posix_path(log),
        **extra_env,
    }
    return subprocess.run(
        [BASH, "scripts/deploy_targeted.sh", VERSION, "prod-host", "/opt/rescene"],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
    )


def call_lines(tmp_path: Path) -> list[str]:
    return (tmp_path / "calls.log").read_text(encoding="utf-8").splitlines()


def index_of(lines: list[str], *needles: str) -> int:
    for index, line in enumerate(lines):
        if all(needle in line for needle in needles):
            return index
    raise AssertionError(f"no call matching {needles} in:\n" + "\n".join(lines))


def indices_of(lines: list[str], *needles: str) -> list[int]:
    return [index for index, line in enumerate(lines) if all(needle in line for needle in needles)]


def phases(tmp_path: Path) -> list[str]:
    log = tmp_path / "deploy-root/.cache/release" / VERSION / "phases.log"
    return [line.split(" ", 1)[1] for line in log.read_text(encoding="utf-8").splitlines()]


def test_records_every_phase_and_promotes_web_only_after_api_is_healthy(tmp_path: Path) -> None:
    result = run_script(tmp_path)
    lines = call_lines(tmp_path)

    assert result.returncode == 0, result.stderr
    assert phases(tmp_path) == ["prepare", "transfer", "load", "api", "web", "verify"]
    load = index_of(lines, "ssh", "docker load")
    api = index_of(lines, "ssh", "rescene-api:latest")
    web = index_of(lines, "ssh", "rescene-web:latest")
    assert index_of(lines, "scp", "images.tar.gz") < load
    assert load < api, "the API tag may only change after the image archive is loaded"
    assert "up -d --no-deps --no-build api" in lines[api]
    assert api < index_of(lines, "ssh", "State.Health", "api-container-id")
    assert index_of(lines, "ssh", "State.Health", "api-container-id") < web, (
        "web may not change before the API is healthy"
    )
    assert "up -d --no-deps --no-build web" in lines[web]
    assert web < index_of(lines, "curl", "/health/ready")
    assert index_of(lines, "curl", "/health/ready") < index_of(lines, "curl", "https://app.rescene.xyz/")
    assert index_of(lines, "ssh", "after-images.txt") > index_of(lines, "curl")
    deployed = json.loads((tmp_path / "deploy-root/.cache/release" / VERSION / "deployed.json").read_text("utf-8"))
    assert deployed == {
        "version": VERSION,
        "api": "sha256:local-candidate",
        "web": "sha256:local-candidate",
        "api_url": "https://api.rescene.xyz",
        "web_url": "https://app.rescene.xyz",
    }


def test_failed_load_leaves_both_tags_and_services_alone(tmp_path: Path) -> None:
    result = run_script(tmp_path, STUB_LOAD_OK="0")
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "phase 'load'" in result.stderr
    assert "nothing to restore" in result.stderr
    assert indices_of(lines, "docker tag") == []
    assert indices_of(lines, "up -d") == []
    assert "rescene-api:latest" not in " ".join(lines)


def test_unhealthy_api_restores_only_the_api(tmp_path: Path) -> None:
    result = run_script(tmp_path, STUB_HEALTH_API="starting", STUB_SINGLE_PROBE="1", RESCENE_COMPAT_VERIFIED="1")
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "phase 'api'" in result.stderr
    restores = indices_of(lines, "docker tag", "before-images.txt")
    assert len(restores) == 1
    assert "rescene-api" in lines[restores[0]] and "rescene-web" not in lines[restores[0]]
    assert indices_of(lines, "rescene-web:latest") == []
    assert "Restored the images this run replaced." in result.stderr


def test_unhealthy_web_restores_web_before_api(tmp_path: Path) -> None:
    result = run_script(tmp_path, STUB_HEALTH_WEB="starting", STUB_SINGLE_PROBE="1", RESCENE_COMPAT_VERIFIED="1")
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "phase 'web'" in result.stderr
    restores = indices_of(lines, "docker tag", "before-images.txt")
    assert len(restores) == 2
    assert "rescene-web" in lines[restores[0]]
    assert "rescene-api" in lines[restores[1]]
    assert indices_of(lines, "curl") == []


def test_unverified_compatibility_reports_state_without_restoring(tmp_path: Path) -> None:
    result = run_script(tmp_path, STUB_HEALTH_WEB="starting", STUB_SINGLE_PROBE="1")
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "phase 'web'" in result.stderr
    assert "not verified against the migrated schema" in result.stderr
    assert "before-images.txt" in result.stderr
    assert indices_of(lines, "docker tag", "before-images.txt") == []


def test_failed_restore_stops_and_keeps_the_original_error(tmp_path: Path) -> None:
    result = run_script(
        tmp_path, STUB_HEALTH_WEB="starting", STUB_SINGLE_PROBE="1", RESCENE_COMPAT_VERIFIED="1", STUB_RESTORE_FAIL="1"
    )
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "Restoring web failed" in result.stderr
    restores = indices_of(lines, "docker tag", "before-images.txt")
    assert len(restores) == 1
    assert "rescene-web" in lines[restores[0]]


def test_failed_public_probe_restores_both_services(tmp_path: Path) -> None:
    result = run_script(tmp_path, STUB_CURL_FAIL="1", STUB_SINGLE_PROBE="1", RESCENE_COMPAT_VERIFIED="1")
    lines = call_lines(tmp_path)

    assert result.returncode != 0
    assert "phase 'verify'" in result.stderr
    restores = indices_of(lines, "docker tag", "before-images.txt")
    assert len(restores) == 2
    assert "rescene-web" in lines[restores[0]] and "rescene-api" in lines[restores[1]]
    assert indices_of(lines, "after-images.txt") == []
