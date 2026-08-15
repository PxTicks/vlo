"""Read model for the unified model-work queue.

The ledger is a description of what the machine is doing. It carries two
*independent* status fields per entry:

- ``job_status`` is the public lifecycle a user sees (a job can be cancelled);
- ``occupancy`` is the physical truth (the worker thread may still be resident).

Nothing may infer one from the other. A cancelled job whose worker callable has
not returned yet is ``job_status="cancelled"`` and ``occupancy="stopping"``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

LOCAL_GPU_RESOURCE = "local-gpu"

TENANT_BACKEND = "backend-process"
TENANT_COMFYUI = "comfyui-process"

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
OccupancyState = Literal["waiting", "occupied", "stopping", "released"]
Sharing = Literal["exclusive", "tenant"]
TerminalVerdict = Literal["succeeded", "failed", "cancelled"]
WorkSource = Literal[
    "beats",
    "sam2",
    "sam-audio",
    "comfyui-vlo",
    "comfyui-iframe",
    "extension",
]

TERMINAL_JOB_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})

#: Sharing mode per execution tenant. Callers cannot promote an arbitrary tenant
#: to shared ownership; the coordinator validates every reservation against this.
TENANT_SHARING: dict[str, Sharing] = {
    TENANT_BACKEND: "exclusive",
    TENANT_COMFYUI: "tenant",
}


@dataclass
class LedgerEntry:
    entry_id: str
    source: str
    owner: str
    label: str
    resource: str | None = None
    tenant: str | None = None
    job_status: JobStatus = "queued"
    occupancy: OccupancyState = "waiting"
    progress: float | None = None
    message: str | None = None
    submitted_at: float = field(default_factory=time.time)
    started_at: float | None = None
    ended_at: float | None = None
    parent_occupancy_id: str | None = None
    cancel_endpoint: str | None = None
    prompt_id: str | None = None
    suspected_stale: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "entryId": self.entry_id,
            "resource": self.resource,
            "tenant": self.tenant,
            "source": self.source,
            "owner": self.owner,
            "label": self.label,
            "jobStatus": self.job_status,
            "occupancy": self.occupancy,
            "progress": self.progress,
            "message": self.message,
            "submittedAt": self.submitted_at,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "parentOccupancyId": self.parent_occupancy_id,
            "cancelEndpoint": self.cancel_endpoint,
            "promptId": self.prompt_id,
            "suspectedStale": self.suspected_stale,
        }

    def copy(self) -> "LedgerEntry":
        return LedgerEntry(**vars(self))


@dataclass(frozen=True)
class ResourceView:
    """Who currently owns a resource, for admission-aware UI."""

    resource: str
    width: int
    tenant: str | None
    occupancy_id: str | None
    holder_count: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "width": self.width,
            "tenant": self.tenant,
            "occupancyId": self.occupancy_id,
            "holderCount": self.holder_count,
        }


@dataclass(frozen=True)
class LedgerSnapshot:
    revision: int
    ready: bool
    entries: tuple[LedgerEntry, ...]
    resources: tuple[ResourceView, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "revision": self.revision,
            "ready": self.ready,
            "entries": [entry.to_payload() for entry in self.entries],
            "resources": [resource.to_payload() for resource in self.resources],
        }


@dataclass(frozen=True)
class LedgerEvent:
    revision: int
    kind: Literal["added", "updated", "removed"]
    entry: LedgerEntry
    resources: tuple[ResourceView, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "revision": self.revision,
            "kind": self.kind,
            "entry": self.entry.to_payload(),
            "resources": [resource.to_payload() for resource in self.resources],
        }


@dataclass(frozen=True)
class PersistedOccupancy:
    """One in-flight ComfyUI prompt recovered from disk after a restart."""

    prompt_id: str
    source: str
    owner: str
    label: str
    job_status: JobStatus = "running"
    submitted_at: float | None = None
    cancel_endpoint: str | None = None
