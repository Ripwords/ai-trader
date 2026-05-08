"""In-memory TTL cache used to dedup repeated upstream lookups.

A module-level singleton (`cache`) is shared across client.py wrappers.
Entries store a monotonic-clock expiry; reads past expiry evict and miss.
Generic so callers can stash any object (Pydantic models, lists thereof).
"""

from __future__ import annotations

import time
from threading import RLock
from typing import Generic, TypeVar

T = TypeVar("T")


METRICS_TTL_SECONDS = 24 * 60 * 60
HISTORY_TTL_SECONDS = 24 * 60 * 60
INSIDER_TTL_SECONDS = 12 * 60 * 60
NEWS_TTL_SECONDS = 60 * 60


class TTLCache(Generic[T]):
    def __init__(self) -> None:
        self._store: dict[str, tuple[float, T]] = {}
        self._lock = RLock()

    def get(self, key: str) -> T | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if time.monotonic() >= expires_at:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: T, ttl_seconds: float) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + ttl_seconds, value)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


cache: TTLCache[object] = TTLCache()
