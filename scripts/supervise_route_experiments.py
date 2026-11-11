"""Supervise an ordered queue of owned GPU trials and restore the worker."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/root/ReScene")
DATA = Path("/root/autodl-tmp/rescene")
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
            "RESCENE_ROOT": str(ROOT),
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


def monitor(trial: dict[str, object]) -> dict[str, object]:
    name = str(trial["name"])
    run = RUNS / "runs" / name
    log_path = RUNS / "logs" / f"{name}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        raise FileExistsError(log_path)
    command = [
        str(ROOT / ".venv/bin/python"),
        "-u",
        str(ROOT / "scripts" / "route_experiments_v3.py"),
        str(trial["spec"]),
        str(run),
        "--repeat",
        str(trial["repeat"]),
    ]
    with log_path.open("xb") as log:
        process = subprocess.Popen(
            command, cwd=ROOT, env=environment(), stdout=log, stderr=subprocess.STDOUT, start_new_session=True
        )
        start = time.monotonic()
        progress = start
        last_signature = None
        warning = False
        peak = 0
        samples = 0
        reason = None
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
                if foreign:
                    reason = f"external GPU compute PIDs appeared: {foreign}"
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
                if reason is None and now - progress >= STALL_BOUNDS[str(trial["profile"])] and used == 0:
                    reason = (
                        f"no stage/log progress for {STALL_BOUNDS[str(trial['profile'])]}s with no owned GPU memory"
                    )
                if (
                    reason is None
                    and now - progress >= STALL_SECONDS
                    and used == 0
                    and running_stage(run) in GPU_STALL_STAGES
                ):
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
            "wall_seconds": round(time.monotonic() - start, 3),
            "returncode": process.wait(),
            "abort_reason": reason,
            "valid": reason is None and process.returncode == 0,
        }
        atomic_json(RUNS / "resources" / f"{name}.json", result)
        emit(json.dumps(result, sort_keys=True))
        return result


def locked(plan: list[dict[str, object]]) -> int:
    status: dict[str, object] = {"trials": {}, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    code = 0
    for trial in plan:
        name = str(trial["name"])
        existing = RUNS / "resources" / f"{name}.json"
        if existing.exists() and json.loads(existing.read_text()).get("valid") is True:
            status["trials"][name] = "already-valid"
            continue
        if free_bytes() < STOP_FREE_BYTES:
            status["stopped"] = f"free space below {STOP_FREE_BYTES} bytes before {name}"
            code = code or 2
            break
        try:
            result = monitor(trial)
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
            break
    atomic_json(RUNS / "plan-status" / f"{Path(str(plan[0]['spec'])).parent.name}-{plan[0]['name']}.json", status)
    return code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("--locked", action="store_true")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if not plan:
        raise ValueError("Empty trial plan")
    for trial in plan:
        if not Path(str(trial["spec"])).is_file():
            raise FileNotFoundError(trial["spec"])
    (RUNS / "resources").mkdir(parents=True, exist_ok=True)
    (RUNS / "plan-status").mkdir(parents=True, exist_ok=True)
    (RUNS / "runs").mkdir(parents=True, exist_ok=True)
    if args.locked:
        return locked(plan)
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
