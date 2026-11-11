"""Per-process sliding-window limiter for the anonymous authentication endpoints."""

from __future__ import annotations

import threading
import time


class SlidingWindowLimiter:
    """Counts hits per key inside a rolling window.

    Each API process owns its own counters; a single-instance deployment is the
    only supported topology, so no shared store is required.
    """

    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: float) -> float | None:
        """Record a hit; return None when allowed, else seconds until retry is safe."""
        current = time.monotonic()
        with self._lock:
            hits = [stamp for stamp in self._hits.get(key, []) if current - stamp < window_seconds]
            if len(hits) >= limit:
                self._hits[key] = hits
                return max(0.0, window_seconds - (current - hits[0]))
            hits.append(current)
            self._hits[key] = hits
            return None

    def reset(self) -> None:
        """Drop every counter; used by tests and by nothing else."""
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowLimiter()
