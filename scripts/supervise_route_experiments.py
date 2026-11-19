"""Supervise an ordered queue of owned GPU trials and restore the worker."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/root/ReScene")
SOURCE = Path(os.environ.get("RESCENE_EXPERIMENT_SOURCE", ROOT))
DATA = Path("/root/autodl-tmp/rescene")
SHARED = Path("/root/autodl-fs")
RUNS = Path(os.environ.get("RESCENE_DELIVERY_ROOT", DATA / "delivery-v4"))
GPU_BOUNDS = {"fast": 2400, "balanced": 5400, "quality": 9000}
STALL_BOUNDS = {"fast": 900, "balanced": 1800, "quality": 3600}
GPU_STALL_STAGES = {"training"}
STALL_SECONDS = 600
FOREIGN_SAMPLES = 6
MIN_FREE_BYTES = 8 * 1024**3
STOP_FREE_BYTES = 3 * 1024**3


def emit(message: str) -> None:
    print(message, flush=True)


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def stat_fields(pid: int) -> list[str] | None:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (OSError, ValueError, IndexError):
        return None


def session_id(pid: int) -> int | None:
    fields = stat_fields(pid)
    if fields is None or len(fields) < 4:
        return None
    try:
        return int(fields[3])
    except ValueError:
        return None


def owned(pid: int, parent: int) -> bool:
    """True when the GPU pid descends from the trial or shares its session."""
    if pid == parent:
        return True
    parent_session = session_id(parent)
    if parent_session is not None and session_id(pid) == parent_session:
        return True
    for _ in range(32):
        fields = stat_fields(pid)
        if fields is None or len(fields) < 2:
            return False
        try:
            pid = int(fields[1])
        except ValueError:
            return False
        if pid == parent:
            return True
        if pid <= 1:
            return False
    return False


def environment() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "RESCENE_ROOT": str(SOURCE),
            "CUDA_VISIBLE_DEVICES": "0",
            "OMP_NUM_THREADS": "12",
            "MKL_NUM_THREADS": "12",
            "OPENBLAS_NUM_THREADS": "12",
            "NUMEXPR_NUM_THREADS": "12",
            "TORCH_HOME": str(DATA / "cache/torch"),
            "HF_HOME": str(ROOT / ".cache/huggingface"),
            "HF_HUB_OFFLINE": "1",
        }
    )
    if SOURCE != ROOT:
        env["PYTHONPATH"] = str(SOURCE / "src")
    env["LD_LIBRARY_PATH"] = (
        f"{DATA}/runtime/system-libs/usr/lib/x86_64-linux-gnu:"
        f"{ROOT}/.venv/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:"
        f"{ROOT}/.venv/lib/python3.11/site-packages/nvidia/curand/lib:" + env.get("LD_LIBRARY_PATH", "")
    )
    return env


def gpu_processes() -> dict[int, int]:
    raw = subprocess.check_output(
        ["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
        text=True,
        timeout=10,
    ).strip()
    result = {}
    for line in raw.splitlines():
        pid, memory = [part.strip() for part in line.split(",", 1)]
        result[int(pid)] = int(memory)
    return result


def free_bytes() -> int:
    return shutil.disk_usage(DATA).free


def gpu_utilization() -> int | None:
    """Read GPU activity as telemetry without using it to determine ownership."""
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--id=0", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return int(output) if output.isdecimal() else None


def require_free(threshold: int, context: str) -> None:
    available = free_bytes()
    if available < threshold:
        raise RuntimeError(f"{context}: {available} bytes free on data volume is below {threshold}")


def running_stage(run: Path) -> str | None:
    for path in (run / "stages").glob("*.json"):
        try:
            payload = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if payload.get("status") == "running":
            return str(payload.get("stage") or path.stem)
    return None


def require_idle_worker() -> None:
    completed = subprocess.run(
        [str(ROOT / "workerctl"), "status"], capture_output=True, text=True, timeout=30, check=False
    )
    output = f"{completed.stdout}{completed.stderr}".strip()
    if completed.returncode != 0 or "running" not in output or "drain=no" not in output:
        raise RuntimeError(f"workerctl status is not 'running drain=no': {output!r}")
    processes = gpu_processes()
    if processes:
        raise RuntimeError(f"external GPU compute PIDs present before start: {sorted(processes)}")


def trial_requirement(trial: dict, deadline: float | None, free: int, now: float) -> str | None:
    expected = trial.get("expected_write_bytes", 0)
    if free < max(10 * 1024**3, (expected * 13 + 9) // 10):
        return "insufficient_disk"
    estimate = trial.get("wall_estimate_seconds", GPU_BOUNDS[trial["profile"]])
    if deadline is not None and now + estimate >= deadline:
        return "insufficient_time"
    return None


def sha256_spec(trial: dict) -> str:
    return hashlib.sha256(Path(trial["spec"]).read_bytes()).hexdigest()


def require_archive_mount() -> None:
    if archive := os.environ.get("RESCENE_EXPERIMENT_ARCHIVE"):
        shared = SHARED.resolve()
        target = Path(archive).resolve()
        if not target.is_relative_to(shared) or not shared.is_mount():
            raise RuntimeError("Experiment archive requires the mounted /root/autodl-fs volume")


def trial_command(trial: dict) -> list[str]:
    return [
        sys.executable,
        "-u",
        str(SOURCE / "scripts" / "route_experiments_v3.py"),
        str(trial["spec"]),
        str(RUNS / "runs" / trial["name"]),
        "--repeat",
        str(trial["repeat"]),
    ]


def monitor(trial: dict[str, object], deadline: float | None = None) -> dict[str, object]:
    name = str(trial["name"])
    run = RUNS / "runs" / name
    log_path = RUNS / "logs" / f"{name}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists() and not trial.get("resume"):
        raise FileExistsError(log_path)
    command = trial_command(trial)
    if trial.get("resume"):
        command.append("--resume")
    with log_path.open("ab" if trial.get("resume") else "xb") as log:
        process = subprocess.Popen(
            command, cwd=ROOT, env=environment(), stdout=log, stderr=subprocess.STDOUT, start_new_session=True
        )
        start = time.monotonic()
        progress = start
        last_signature = None
        warning = False
        peak = 0
        samples = 0
        phase_samples: dict[str, dict[str, int]] = {}
        reason = None
        failure = None
        foreign_seen: dict[int, int] = {}
        try:
            while process.poll() is None:
                now = time.monotonic()
                files = list((run / "stages").glob("*.json")) + list((run / "logs").glob("*.log")) + [log_path]
                existing = [path for path in files if path.exists()]
                signature = [(str(path), path.stat().st_size, path.stat().st_mtime_ns) for path in existing]
                if signature != last_signature:
                    last_signature, progress, warning = signature, now, False
                processes = gpu_processes()
                used = 0
                foreign = []
                for pid, memory in processes.items():
                    if owned(pid, process.pid):
                        used += memory
                        continue
                    if stat_fields(pid) is None:
                        # nvidia-smi still lists a context whose process already exited.
                        continue
                    seen = foreign_seen.get(pid, 0) + 1
                    foreign_seen[pid] = seen
                    if seen >= FOREIGN_SAMPLES:
                        foreign.append(pid)
                for pid in [key for key in foreign_seen if key not in processes]:
                    del foreign_seen[pid]
                peak = max(peak, used)
                samples += 1
                stage = running_stage(run)
                if stage:
                    phase = phase_samples.setdefault(stage, {"samples": 0, "peak_mib": 0, "utilization_sum": 0})
                    phase["peak_mib"] = max(phase["peak_mib"], used)
                    if samples % 10 == 1:
                        utilization = gpu_utilization() if used and not foreign else 0
                        if utilization is not None:
                            phase["samples"] += 1
                            phase["utilization_sum"] += utilization
                if foreign:
                    reason = f"external GPU compute PIDs appeared: {foreign}"
                if reason is None and deadline is not None and time.time() >= deadline:
                    reason = "batch deadline reached"
                if reason is None and free_bytes() < STOP_FREE_BYTES:
                    reason = "data volume below emergency free-space threshold"
                if samples % 30 == 1:
                    stages = {}
                    for path in (run / "stages").glob("*.json"):
                        try:
                            stages[path.stem] = json.loads(path.read_text()).get("status")
                        except (OSError, ValueError):
                            stages[path.stem] = "updating"
                    emit(
                        json.dumps(
                            {
                                "trial": name,
                                "elapsed_seconds": int(now - start),
                                "unchanged_seconds": int(now - progress),
                                "owned_gpu_mib": used,
                                "peak_owned_gpu_mib_sampled": peak,
                                "stages": stages,
                                "logs": {path.name: path.stat().st_size for path in existing},
                            },
                            sort_keys=True,
                        )
                    )
                if now - progress >= 180 and not warning:
                    emit(f"WARNING [{name}]: no stage/log progress for 180 seconds")
                    warning = True
                if reason is None and now - start >= GPU_BOUNDS[str(trial["profile"])]:
                    reason = f"stage runtime bound {GPU_BOUNDS[str(trial['profile'])]}s exceeded"
                    failure = "trial_timeout"
                if reason is None and now - progress >= STALL_BOUNDS[str(trial["profile"])] and used == 0:
                    reason = (
                        f"no stage/log progress for {STALL_BOUNDS[str(trial['profile'])]}s with no owned GPU memory"
                    )
                if reason is None and now - progress >= STALL_SECONDS and used == 0 and stage in GPU_STALL_STAGES:
                    reason = f"{STALL_SECONDS}s without progress in a GPU stage and no owned GPU memory"
                if reason:
                    emit(f"ABORT [{name}]: {reason}")
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=90)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                    break
                time.sleep(0.5)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=90)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
        result = {
            "trial": name,
            "profile": trial["profile"],
            "sample_interval_seconds": 0.5,
            "peak_owned_gpu_mib_sampled": peak,
            "gpu_samples": samples,
            "phase_gpu": {
                stage: {
                    "samples": phase["samples"],
                    "peak_owned_mib": phase["peak_mib"],
                    "mean_utilization_percent": (
                        round(phase["utilization_sum"] / phase["samples"], 2) if phase["samples"] else None
                    ),
                }
                for stage, phase in phase_samples.items()
            },
            "wall_seconds": round(time.monotonic() - start, 3),
            "returncode": process.wait(),
            "abort_reason": reason,
            "valid": reason is None and process.returncode == 0,
            "spec_sha256": sha256_spec(trial),
        }
        failure_path = run / "trial_failure.json"
        if reason is None and process.returncode and failure_path.is_file():
            failure = json.loads(failure_path.read_text(encoding="utf-8"))["reason"]
        result["trial_failure"] = failure
        atomic_json(RUNS / "resources" / f"{name}.json", result)
        emit(json.dumps(result, sort_keys=True))
        return result


def locked(plan: list[dict[str, object]], deadline: float | None = None) -> int:
    status: dict[str, object] = {"trials": {}, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    code = 0
    for trial in plan:
        name = str(trial["name"])
        existing = RUNS / "resources" / f"{name}.json"
        if existing.exists() and (previous := json.loads(existing.read_text())).get("valid") is True:
            if previous.get("spec_sha256") != sha256_spec(trial):
                raise ValueError(f"Existing valid result has a different or missing specification hash: {name}")
            subprocess.run([*trial_command(trial), "--verify-completed"], check=True, cwd=ROOT)
            status["trials"][name] = "already-valid"
            continue
        requirement = trial_requirement(trial, deadline, free_bytes(), time.time())
        if requirement == "insufficient_time":
            status["trials"][name] = requirement
            code = code or 2
            continue
        if requirement is not None:
            status["stopped"] = f"{requirement} before {name}"
            code = code or 2
            break
        try:
            require_archive_mount()
            result = monitor(trial, deadline)
        except Exception as error:
            status["trials"][name] = f"supervisor-error: {type(error).__name__}: {error}"
            code = code or 1
            break
        status["trials"][name] = "valid" if result["valid"] else result
        status["free_bytes"] = free_bytes()
        if free_bytes() < STOP_FREE_BYTES:
            status["stopped"] = f"free space below {STOP_FREE_BYTES} bytes after {name}"
            code = code or 2
            break
        if not result["valid"]:
            code = code or 1
            if not result.get("trial_failure"):
                break
    atomic_json(RUNS / "plan-status" / f"{Path(str(plan[0]['spec'])).parent.name}-{plan[0]['name']}.json", status)
    return code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("--locked", action="store_true")
    parser.add_argument("--deadline-epoch", type=int)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if not plan:
        raise ValueError("Empty trial plan")
    names = set()
    for trial in plan:
        name = trial["name"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", name) or name in names:
            raise ValueError(f"Invalid or duplicate trial name: {name}")
        names.add(name)
        if not Path(str(trial["spec"])).is_file():
            raise FileNotFoundError(trial["spec"])
        if trial["profile"] not in GPU_BOUNDS or type(trial["repeat"]) is not int or trial["repeat"] < 1:
            raise ValueError(f"Invalid trial profile or repeat: {name}")
        for field in ("expected_write_bytes", "wall_estimate_seconds"):
            if (args.deadline_epoch is not None or field in trial) and (
                type(trial.get(field)) is not int or trial[field] <= 0
            ):
                raise ValueError(f"{name} requires positive {field}")
    if args.deadline_epoch is not None and time.time() >= args.deadline_epoch:
        return 2
    require_archive_mount()
    (RUNS / "resources").mkdir(parents=True, exist_ok=True)
    (RUNS / "plan-status").mkdir(parents=True, exist_ok=True)
    (RUNS / "runs").mkdir(parents=True, exist_ok=True)
    if args.locked:
        return locked(plan, args.deadline_epoch)
    require_free(MIN_FREE_BYTES, "start")
    require_idle_worker()
    subprocess.run([str(ROOT / "workerctl"), "drain"], check=True, timeout=20)
    subprocess.run([str(ROOT / "workerctl"), "stop"], check=True, timeout=60)
    child = None
    try:
        child = subprocess.Popen(
            [
                "flock",
                "--close",
                "-w",
                "600",
                str(ROOT / ".gpu.lock"),
                sys.executable,
                "-u",
                __file__,
                str(args.plan),
                "--locked",
                *(["--deadline-epoch", str(args.deadline_epoch)] if args.deadline_epoch is not None else []),
            ],
            cwd=ROOT,
            start_new_session=True,
        )

        def interrupted(signum: int, _frame: object) -> None:
            raise SystemExit(128 + signum)

        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGHUP, interrupted)
        return child.wait()
    finally:
        if child is not None and child.poll() is None:
            children_file = Path(f"/proc/{child.pid}/task/{child.pid}/children")
            children = children_file.read_text().split() if children_file.exists() else []
            for pid in children or [str(child.pid)]:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(int(pid), signal.SIGTERM)
            try:
                child.wait(timeout=120)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("Owned trials did not stop; refusing unsafe worker restart") from error
        subprocess.run([str(ROOT / "workerctl"), "start"], check=True, timeout=60)
        subprocess.run([str(ROOT / "workerctl"), "status"], check=True, timeout=30)


if __name__ == "__main__":
    sys.exit(main())
