"""Per-process sliding-window limiter for the anonymous authentication endpoints."""

from __future__ import annotations

import threading
import time

# Keys are dropped once their newest hit leaves the window; scanning at most this
# often keeps a flood of fresh addresses from turning every request into a sweep.
PRUNE_INTERVAL_SECONDS = 30.0


class SlidingWindowLimiter:
    """Counts hits per key inside a rolling window.

    Each API process owns its own counters; a single-instance deployment is the
    only supported topology, so no shared store is required. Expired keys are
    swept periodically so the map only tracks addresses active in the window.
    """

    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = {}
        self._windows: dict[str, float] = {}
        self._next_prune = 0.0
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: float) -> float | None:
        """Record a hit; return None when allowed, else seconds until retry is safe."""
        current = time.monotonic()
        with self._lock:
            if current >= self._next_prune:
                self._prune(current)
                self._next_prune = current + PRUNE_INTERVAL_SECONDS
            hits = [stamp for stamp in self._hits.get(key, []) if current - stamp < window_seconds]
            self._windows[key] = window_seconds
            if len(hits) >= limit:
                self._hits[key] = hits
                return max(0.0, window_seconds - (current - hits[0]))
            hits.append(current)
            self._hits[key] = hits
            return None

    def _prune(self, current: float) -> None:
        """Forget keys whose newest hit has left its own window."""
        stale = [
            key for key, hits in self._hits.items() if not hits or current - hits[-1] >= self._windows.get(key, 0.0)
        ]
        for key in stale:
            del self._hits[key]
            self._windows.pop(key, None)

    def reset(self) -> None:
        """Drop every counter; used by tests and by nothing else."""
        with self._lock:
            self._hits.clear()
            self._windows.clear()
            self._next_prune = 0.0


limiter = SlidingWindowLimiter()
