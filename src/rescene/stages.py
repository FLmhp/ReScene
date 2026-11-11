"""Durable stage state for resumable scene runs."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter


def _now() -> str:
    return datetime.now(UTC).isoformat()


class StageStore:
    """Persist one JSON document per pipeline stage."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def path(self, name: str) -> Path:
        return self.directory / f"{name}.json"

    def read(self, name: str) -> dict[str, object]:
        path = self.path(name)
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def complete(self, name: str, outputs: list[Path] | None = None) -> bool:
        state = self.read(name)
        return state.get("status") == "success" and all(
            path.exists() and (not path.is_file() or path.stat().st_size > 0) for path in outputs or []
        )

    def write(self, name: str, **values: object) -> None:
        path = self.path(name)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(values, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        temporary.replace(path)

    @contextmanager
    def running(self, name: str, **details: object) -> Iterator[dict[str, object]]:
        started = perf_counter()
        state: dict[str, object] = {"status": "running", "started_at": _now(), **details}
        self.write(name, **state)
        try:
            yield state
        except Exception as error:
            failed = state | {
                "status": "failed",
                "finished_at": _now(),
                "duration_seconds": round(perf_counter() - started, 3),
                "error": f"{type(error).__name__}: {error}",
            }
            self.write(name, **failed)
            raise
        succeeded = state | {
            "status": "success",
            "finished_at": _now(),
            "duration_seconds": round(perf_counter() - started, 3),
        }
        self.write(name, **succeeded)
