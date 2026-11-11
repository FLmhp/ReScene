from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, Thread

import imageio_ffmpeg
import oss2
from oss2.credentials import Credentials, CredentialsProvider
from PIL import Image

from rescene.metrics import final_ply_path
from rescene.preprocess import IMAGE_SUFFIXES, VIDEO_SUFFIXES, video_input_args
from rescene_worker.logs import LogShipper


@dataclass(frozen=True)
class WorkerConfig:
    api_url: str
    worker_id: str
    token: str
    work_root: Path
    poll_seconds: int = 5


def load_config() -> WorkerConfig:
    token_file = Path(os.environ["RESCENE_WORKER_TOKEN_FILE"])
    return WorkerConfig(
        api_url=os.environ["RESCENE_API_URL"].rstrip("/"),
        worker_id=os.environ.get("RESCENE_WORKER_ID", "autodl-5090"),
        token=token_file.read_text(encoding="utf-8").strip(),
        work_root=Path(os.environ.get("RESCENE_WORK_ROOT", "/root/autodl-tmp/rescene/jobs")).resolve(),
        poll_seconds=int(os.environ.get("RESCENE_WORKER_POLL_SECONDS", "5")),
    )


class Api:
    def __init__(self, config: WorkerConfig, attempt: int | None = None) -> None:
        self.config = config
        self.attempt = attempt
        self.gpu = gpu_name()

    def post(self, path: str, payload: dict | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "Content-Type": "application/json",
            "X-Worker-Id": self.config.worker_id,
            "X-GPU-Name": self.gpu,
        }
        if self.attempt is not None:
            headers["X-Lease-Attempt"] = str(self.attempt)
        request = urllib.request.Request(
            f"{self.config.api_url}{path}",
            data=json.dumps(payload or {}).encode(),
            headers=headers,
            method="POST",
        )
        heartbeat = path.endswith("/heartbeat")
        attempts = 1 if heartbeat or path == "/v1/worker/lease" else 3
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=8 if heartbeat else 25) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as error:
                if error.code < 500 or attempt == attempts - 1:
                    raise
            except (OSError, json.JSONDecodeError) as error:
                if attempt == attempts - 1:
                    raise RuntimeError(f"Worker API request failed: {error}") from error
            time.sleep(2**attempt)
        raise AssertionError("Worker API retry loop exhausted")


def gpu_name() -> str:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip().splitlines()[0] if result.returncode == 0 and result.stdout.strip() else "unknown"


def gpu_has_compute_process() -> bool:
    result = subprocess.run(
        ["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode != 0 or bool(result.stdout.strip())


@contextmanager
def gpu_slot() -> Iterator[int | None]:
    """Use the same GPU lock as SSH benchmark and reconstruction launchers."""
    import fcntl

    root = Path(os.environ.get("RESCENE_ROOT", str(Path.cwd())))
    with (root / ".gpu.lock").open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
        else:
            yield lock.fileno()


class JobCredentials(CredentialsProvider):
    """Refresh the attempt-scoped STS credentials when OSS signs a request."""

    def __init__(self, api: Api, endpoint: str, initial: dict) -> None:
        self.api = api
        self.endpoint = endpoint
        self.grant = initial

    def get_credentials(self) -> Credentials:
        """Return a credential with enough time for the next OSS operation."""
        expires = datetime.fromisoformat(self.grant["expiration"])
        if (expires - datetime.now(UTC)).total_seconds() < 120:
            self.grant = self.api.post(f"{self.endpoint}/credentials")
        return Credentials(self.grant["access_key_id"], self.grant["access_key_secret"], self.grant["security_token"])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def restore_archive(bucket: oss2.Bucket, key: str, job_dir: Path) -> None:
    archive = job_dir.parent / f"{job_dir.name}.resume.tar.gz"
    bucket.get_object_to_file(key, str(archive))
    with tarfile.open(archive, "r:gz") as source:
        root = job_dir.resolve()
        for member in source.getmembers():
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError(f"Unsafe archive member type: {member.name}")
            target = (job_dir / member.name).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"Unsafe archive member: {member.name}")
        source.extractall(job_dir)
    archive.unlink(missing_ok=True)


def archive_stage(bucket: oss2.Bucket, job_dir: Path, output_prefix: str, stage: str) -> str:
    archive = job_dir.parent / f"{job_dir.name}-{stage}.tar.gz"
    stage_files = {
        "preprocess": {"images", "input_manifest.json"},
        "geometry": {"sparse", "dense", "degradation.json"},
        "training": {"gsplat"},
        "export": {"scene.spz", "metrics.json", "report.md"},
    }
    included = {"config.json", "benchmark.json", "environment.json"}
    completed = []
    for name, paths in stage_files.items():
        included.update(paths)
        completed.append(name)
        if name == stage:
            break
    with tarfile.open(archive, "w:gz", compresslevel=1) as target:
        for name in sorted(included):
            path = job_dir / name
            if path.exists():
                target.add(path, arcname=name)
        for name in completed:
            target.add(job_dir / "stages" / f"{name}.json", arcname=f"stages/{name}.json")
    key = f"{output_prefix}checkpoints/{stage}.tar.gz"
    try:
        oss2.resumable_upload(bucket, key, str(archive), multipart_threshold=64 * 1024**2, num_threads=1)
    finally:
        archive.unlink(missing_ok=True)
    return key


def stage_progress(stage: str, status: str) -> float:
    values = {"preprocess": 0.2, "geometry": 0.5, "training": 0.9, "export": 0.98}
    value = values.get(stage, 0.0)
    return value if status == "success" else max(0.0, value - 0.1)


def is_resumed_stage(job: dict, stage: str) -> bool:
    stages = ("preprocess", "geometry", "training", "export")
    key = str(job.get("resume_artifact_key") or "")
    return any(key.endswith(f"/checkpoints/{name}.tar.gz") for name in stages[stages.index(stage) :])


class JobCancelled(RuntimeError):
    """The user requested cancellation of this attempt."""


class LeaseLost(RuntimeError):
    """The Worker can no longer confirm ownership of this attempt."""


class InvalidInput(ValueError):
    """The downloaded assets cannot be used for reconstruction."""


@contextmanager
def lease_watch(api: Api, endpoint: str) -> Iterator[tuple[Event, Event]]:
    """Keep the lease alive while downloads, archives or uploads are running."""
    stop, cancelled, lost = Event(), Event(), Event()

    def heartbeat() -> None:
        last_contact = time.monotonic()
        while not stop.is_set():
            try:
                response = api.post(f"{endpoint}/heartbeat", {"progress": 0.0})
                last_contact = time.monotonic()
                if response.get("cancel_requested"):
                    cancelled.set()
            except (OSError, RuntimeError) as error:
                if getattr(error, "code", None) == 409 or time.monotonic() - last_contact >= 65:
                    lost.set()
                    return
            stop.wait(10)

    thread = Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        yield cancelled, lost
    finally:
        stop.set()
        thread.join(timeout=10)


def check_lease(events: tuple[Event, Event]) -> None:
    """Stop before publishing on cancellation or after lease loss."""
    cancelled, lost = events
    if lost.is_set():
        raise LeaseLost("Worker lease lost")
    if cancelled.is_set():
        raise JobCancelled("Cancelled by user")


def terminate_job_group(process: subprocess.Popen) -> None:
    """Terminate only the process group created for this job."""
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    with suppress(subprocess.TimeoutExpired):
        process.wait(timeout=5)
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    process.wait()


def monitor_job(
    api: Api,
    endpoint: str,
    job: dict,
    process: subprocess.Popen,
    job_dir: Path,
    bucket: oss2.Bucket,
    events: tuple[Event, Event],
) -> None:
    """Report stages and terminate the engine when ownership ends."""
    sent: dict[str, float] = {}
    while True:
        check_lease(events)
        finished = process.poll() is not None
        for stage in ("preprocess", "geometry", "training", "export"):
            state_path = job_dir / "stages" / f"{stage}.json"
            if not state_path.is_file():
                continue
            state = json.loads(state_path.read_text(encoding="utf-8"))
            modified = state_path.stat().st_mtime
            if state.get("status") == "success" and is_resumed_stage(job, stage):
                sent[stage] = modified
                continue
            if sent.get(stage) == modified:
                continue
            resume_key = None
            if state.get("status") == "success" and (stage != "export" or finished):
                resume_key = archive_stage(bucket, job_dir, job["output_prefix"], stage)
            elif stage == "export" and state.get("status") == "success":
                continue
            check_lease(events)
            api.post(
                f"{endpoint}/stage",
                {
                    "stage": stage,
                    "status": state.get("status", "running"),
                    "progress": stage_progress(stage, str(state.get("status"))),
                    "message": state.get("error"),
                    "metrics": {"duration_seconds": state.get("duration_seconds")},
                    "resume_artifact_key": resume_key,
                },
            )
            sent[stage] = modified
        if finished:
            return
        events[0].wait(2)


def artifacts(job_dir: Path, bucket: oss2.Bucket, output_prefix: str) -> list[dict]:
    candidates: list[tuple[str, Path]] = []
    for kind, name in (("spz", "scene.spz"), ("metrics", "metrics.json"), ("report", "report.md")):
        path = job_dir / name
        if path.is_file():
            candidates.append((kind, path))
    candidates.append(("ply", final_ply_path(job_dir)))
    if len(candidates) != 4:
        raise RuntimeError("Job completed without all required deliverable artifacts")
    for kind, name in (("dense", "fused.ply"), ("mesh", "meshed-poisson.ply")):
        path = job_dir / "dense" / name
        if path.is_file() and path.stat().st_size:
            candidates.append((kind, path))
    result = []
    for kind, path in candidates:
        key = f"{output_prefix}artifacts/{kind}/{path.name}"
        oss2.resumable_upload(bucket, key, str(path), multipart_threshold=64 * 1024**2, num_threads=1)
        result.append(
            {
                "kind": kind,
                "object_key": key,
                "sha256": sha256_file(path),
                "size": path.stat().st_size,
                "content_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            }
        )
    manifest = job_dir / "manifest.json"
    manifest.write_text(json.dumps({"version": 1, "artifacts": result}, indent=2), encoding="utf-8")
    key = f"{output_prefix}artifacts/manifest/manifest.json"
    bucket.put_object_from_file(key, str(manifest), headers={"Content-Type": "application/json"})
    result.append(
        {
            "kind": "manifest",
            "object_key": key,
            "size": manifest.stat().st_size,
            "sha256": sha256_file(manifest),
            "content_type": "application/json",
        }
    )
    return result


def safe_cleanup(job_dir: Path, work_root: Path) -> None:
    resolved = job_dir.resolve()
    root = work_root.resolve()
    if resolved == root or root not in resolved.parents:
        raise RuntimeError(f"Refusing to clean unsafe path: {resolved}")
    shutil.rmtree(resolved)


def validate_asset(path: Path, size: int, sha256: str | None) -> None:
    """Verify the downloaded bytes and check that the input can be decoded."""
    if path.stat().st_size != size or (sha256 and sha256_file(path) != sha256):
        raise InvalidInput(f"Asset integrity check failed: {path.name}")
    try:
        if path.suffix in IMAGE_SUFFIXES:
            with Image.open(path) as image:
                expected = "PNG" if path.suffix == ".png" else "JPEG"
                if image.format != expected or image.width * image.height > 64_000_000:
                    raise InvalidInput(f"Unexpected image format or dimensions: {path.name}")
                image.load()
        else:
            result = subprocess.run(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(),
                    "-nostdin",
                    "-v",
                    "error",
                    "-xerror",
                    *video_input_args(path),
                    "-map",
                    "0:v:0",
                    "-frames:v",
                    "1",
                    "-f",
                    "framehash",
                    "-",
                ],
                capture_output=True,
                check=True,
                timeout=45,
            )
            if not any(line and not line.startswith(b"#") for line in result.stdout.splitlines()):
                raise InvalidInput(f"No decodable video frame: {path.name}")
    except (OSError, Image.DecompressionBombError, subprocess.SubprocessError) as error:
        raise InvalidInput(f"Cannot decode asset: {path.name}") from error


def download_inputs(
    bucket: oss2.Bucket,
    assets: list[dict],
    input_dir: Path,
    events: tuple[Event, Event],
) -> Path:
    """Download one video or a collision-free, deterministic set of images."""
    ordered = sorted(assets, key=lambda item: (item["filename"], item["id"]))
    suffixes = [Path(item["filename"]).suffix.lower() for item in ordered]
    is_video = len(suffixes) == 1 and suffixes[0] in VIDEO_SUFFIXES
    if not ordered or (not is_video and any(suffix not in IMAGE_SUFFIXES for suffix in suffixes)):
        raise InvalidInput("Select a set of images or one video")
    if sum(item["size"] for item in assets) + 8 * 1024**3 > shutil.disk_usage(input_dir).free:
        raise RuntimeError("Insufficient free space for job input and reconstruction")
    for index, (item, suffix) in enumerate(zip(ordered, suffixes, strict=True)):
        check_lease(events)
        path = input_dir / f"{index:06d}{suffix}"
        bucket.get_object_to_file(item["object_key"], str(path))
        validate_asset(path, item["size"], item.get("sha256"))
    return path if is_video else input_dir


def execute_attempt(
    api: Api, endpoint: str, job: dict, job_dir: Path, events: tuple[Event, Event], lock_fd: int
) -> None:
    """Restore inputs and stages, run the engine, then publish validated artifacts."""
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    grant = job["oss"]
    auth = oss2.ProviderAuth(JobCredentials(api, endpoint, grant))
    bucket = oss2.Bucket(auth, grant["endpoint"], grant["bucket"], connect_timeout=20)
    input_path = download_inputs(bucket, job["assets"], input_dir, events)
    resume_key = job.get("resume_artifact_key")
    if resume_key:
        try:
            restore_archive(bucket, resume_key, output_dir)
        except (oss2.exceptions.NoSuchKey, tarfile.ReadError, EOFError) as error:
            print(f"{job['job_id']} checkpoint unavailable ({type(error).__name__}); restarting", flush=True)
            safe_cleanup(output_dir, job_dir)
            output_dir.mkdir()
            job = {**job, "resume_artifact_key": None}
            resume_key = None
    check_lease(events)
    spec = job_dir / "job.json"
    spec.write_text(
        json.dumps(
            {
                "job_id": job["job_id"],
                "profile": job["profile"],
                "input_path": str(input_path),
                "resume": bool(resume_key),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    log_path = job_dir / "worker.log"
    command = [sys.executable, "-m", "rescene", "run-job", "--job-spec", str(spec), "--output", str(output_dir)]
    with log_path.open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            pass_fds=(lock_fd,),
        )
        shipper = LogShipper(
            api,
            endpoint,
            job["attempt"],
            lambda: [log_path, *sorted((output_dir / "logs").glob("*.log"))],
        )
        shipper.start()
        try:
            monitor_job(api, endpoint, job, process, output_dir, bucket, events)
        except BaseException:
            terminate_job_group(process)
            raise
        finally:
            shipper.stop()
    for stage_log in (log_path, *(output_dir / "logs").glob("*.log")):
        with suppress(oss2.exceptions.OssError, OSError):
            if stage_log.stat().st_size:
                bucket.put_object_from_file(f"{job['output_prefix']}logs/{stage_log.name}", str(stage_log))
    if process.returncode != 0:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        api.post(
            f"{endpoint}/fail",
            {"error_code": "ENGINE_FAILED", "error_message": tail[-4000:] or "Engine failed", "retryable": False},
        )
        return
    metrics_path = output_dir / "metrics.json"
    metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else {}
    published = artifacts(output_dir, bucket, job["output_prefix"])
    check_lease(events)
    api.post(f"{endpoint}/complete", {"artifacts": published, "quality_score": metrics.get("psnr")})


def execute(config: WorkerConfig, job: dict, lock_fd: int) -> None:
    """Execute one fenced attempt and remove only that attempt's work files."""
    job_id = str(job["job_id"])
    attempt = int(job["attempt"])
    job_dir = (config.work_root / job_id / f"attempt-{attempt}").resolve()
    if job_dir.parent.parent != config.work_root:
        raise RuntimeError("Invalid job directory")
    job_dir.mkdir(parents=True, exist_ok=False)
    endpoint = f"/v1/worker/jobs/{job_id}"
    api = Api(config, attempt)
    try:
        with lease_watch(api, endpoint) as events:
            try:
                execute_attempt(api, endpoint, job, job_dir, events, lock_fd)
            except LeaseLost:
                raise
            except (InvalidInput, OSError, RuntimeError, oss2.exceptions.OssError, tarfile.TarError) as error:
                code = (
                    "CANCELLED"
                    if events[0].is_set()
                    else "INVALID_INPUT"
                    if isinstance(error, InvalidInput)
                    else "INFRASTRUCTURE_ERROR"
                )
                print(f"{job_id} attempt {attempt}: {code} ({type(error).__name__})", flush=True)
                if not events[1].is_set():
                    api.post(
                        f"{endpoint}/fail",
                        {
                            "error_code": code,
                            "error_message": str(error)[:4000] if code == "INVALID_INPUT" else code,
                            "retryable": code == "INFRASTRUCTURE_ERROR",
                        },
                    )
    finally:
        safe_cleanup(job_dir, config.work_root)


def run_forever() -> None:
    config = load_config()
    config.work_root.mkdir(parents=True, exist_ok=True)
    drain_file = Path(os.environ.get("RESCENE_DRAIN_FILE", "/root/autodl-tmp/rescene/state/drain"))
    api = Api(config)
    while True:
        try:
            if drain_file.exists():
                time.sleep(config.poll_seconds)
                continue
            with gpu_slot() as lock_fd:
                if lock_fd is not None and not gpu_has_compute_process():
                    job = api.post("/v1/worker/lease").get("job")
                    if job:
                        execute(config, job, lock_fd)
                        continue
            time.sleep(config.poll_seconds)
        except (OSError, RuntimeError, urllib.error.URLError, oss2.exceptions.OssError) as error:
            print(f"worker error: {type(error).__name__}", file=sys.stderr, flush=True)
            time.sleep(max(10, config.poll_seconds))


def run() -> None:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    run_forever()


if __name__ == "__main__":
    run()
