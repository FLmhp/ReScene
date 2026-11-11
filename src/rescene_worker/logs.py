"""Tail worker and stage logs, then forward new lines to the API in bounded batches."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from pathlib import Path
from threading import Event, Thread
from typing import Protocol

MAX_LINE_CHARACTERS = 4000
MAX_BATCH_LINES = 200

_ERROR = re.compile(r"\b(error|traceback|exception|failed)\b", re.IGNORECASE)
_WARNING = re.compile(r"\bwarn", re.IGNORECASE)


class LogPoster(Protocol):
    def post(self, path: str, payload: dict | None = None) -> dict: ...


def classify(line: str) -> str:
    """Map a raw log line onto the four levels the API accepts."""
    if _ERROR.search(line):
        return "error"
    if _WARNING.search(line):
        return "warning"
    return "info"


class LogShipper:
    """Best-effort log forwarding: a failed POST never disturbs the running job."""

    def __init__(
        self,
        api: LogPoster,
        endpoint: str,
        attempt: int,
        paths: Callable[[], Iterable[Path]],
        interval: float = 2.0,
    ) -> None:
        self.api = api
        self.endpoint = endpoint
        self.attempt = attempt
        self.interval = interval
        self._paths = paths
        self._stop = Event()
        self._thread = Thread(target=self._run, name="rescene-log-shipper", daemon=True)
        self._offsets: dict[Path, int] = {}
        self._buffers: dict[Path, bytes] = {}

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        """Stop tailing, then flush whatever the last interval left behind."""
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=10)
        self.ship(self.drain())

    def drain(self) -> list[dict]:
        """Return only the complete lines appended since the previous call."""
        lines: list[dict] = []
        for path in self._paths():
            try:
                size = path.stat().st_size
            except OSError:
                continue
            offset = self._offsets.get(path, 0)
            if size < offset:
                offset = 0
                self._buffers.pop(path, None)
            if size == offset:
                continue
            try:
                with path.open("rb") as handle:
                    handle.seek(offset)
                    chunk = handle.read()
            except OSError:
                continue
            self._offsets[path] = offset + len(chunk)
            pending = self._buffers.get(path, b"") + chunk
            complete, _, remainder = pending.rpartition(b"\n")
            self._buffers[path] = remainder
            for raw in complete.split(b"\n"):
                message = raw.decode("utf-8", errors="replace").strip()[:MAX_LINE_CHARACTERS]
                if message:
                    lines.append({"level": classify(message), "message": message})
        return lines

    def ship(self, lines: list[dict]) -> None:
        """Post in batches; stop at the first failure so a dead API costs one attempt."""
        for start in range(0, len(lines), MAX_BATCH_LINES):
            batch = lines[start : start + MAX_BATCH_LINES]
            try:
                self.api.post(f"{self.endpoint}/logs", {"attempt": self.attempt, "lines": batch})
            except Exception:
                return

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.ship(self.drain())
