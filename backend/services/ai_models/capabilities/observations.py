"""In-process observations made by explicit or real runtime loads.

Cheap capability checks describe what is installed. These records describe
what this backend process has actually done: a successful load remains useful
evidence until restart, while ``checking`` exists only for the lifetime of an
explicit probe job.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime

from .contract import utc_now
from .failures import sanitize_message


@dataclass(frozen=True)
class LoadSuccessRecord:
    occurred_at: datetime
    resolved_device: str | None = None
    detail: str | None = None


class RuntimeObservationStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._successes: dict[str, LoadSuccessRecord] = {}
        self._checking: set[str] = set()

    def note_success(
        self,
        capability_id: str,
        *,
        resolved_device: str | None = None,
        detail: str | None = None,
    ) -> LoadSuccessRecord:
        record = LoadSuccessRecord(
            occurred_at=utc_now(),
            resolved_device=resolved_device,
            detail=sanitize_message(detail) or None,
        )
        with self._lock:
            self._successes[capability_id] = record
        return record

    def success(self, capability_id: str) -> LoadSuccessRecord | None:
        with self._lock:
            return self._successes.get(capability_id)

    def set_checking(self, capability_id: str, checking: bool) -> None:
        with self._lock:
            if checking:
                self._checking.add(capability_id)
            else:
                self._checking.discard(capability_id)

    def is_checking(self, capability_id: str) -> bool:
        with self._lock:
            return capability_id in self._checking

    def clear(self) -> None:
        with self._lock:
            self._successes.clear()
            self._checking.clear()


_STORE = RuntimeObservationStore()


def note_load_success(
    capability_id: str,
    *,
    resolved_device: str | None = None,
    detail: str | None = None,
) -> LoadSuccessRecord:
    return _STORE.note_success(
        capability_id,
        resolved_device=resolved_device,
        detail=detail,
    )


def get_load_success(capability_id: str) -> LoadSuccessRecord | None:
    return _STORE.success(capability_id)


def set_capability_checking(capability_id: str, checking: bool) -> None:
    _STORE.set_checking(capability_id, checking)


def is_capability_checking(capability_id: str) -> bool:
    return _STORE.is_checking(capability_id)


def clear_runtime_observations() -> None:
    """Reset process-local observations. Tests only."""

    _STORE.clear()

