"""Unified admission authority and ledger for GPU-executing work.

See ``docs/unified-model-queue-plan.md``. The coordinator executes nothing; it
owns admission and the read model. ``BackendJobManager`` remains the executor
for job-shaped work, and the synchronous SAM2/beats worker callables acquire
leases directly.
"""

from __future__ import annotations

import threading

from services.model_work.coordinator import (
    LEDGER_GAP,
    LedgerStream,
    ModelWorkCoordinator,
)
from services.model_work.leases import (
    CoordinatorNotReadyError,
    Lease,
    LeaseAbandonedError,
    LeaseInvalidError,
    LeaseTimeoutError,
    ModelWorkError,
    MonitorToken,
    run_with_lease,
)
from services.model_work.ledger import (
    LOCAL_GPU_RESOURCE,
    TENANT_BACKEND,
    TENANT_COMFYUI,
    JobStatus,
    LedgerEntry,
    LedgerEvent,
    LedgerSnapshot,
    OccupancyState,
    PersistedOccupancy,
    ResourceView,
    TerminalVerdict,
)
from services.model_work.locality import comfy_resource_key, is_comfyui_gpu_local
from services.model_work.vram import release_cuda_cache

_COORDINATOR: ModelWorkCoordinator | None = None
_COORDINATOR_LOCK = threading.Lock()


def get_model_work_coordinator() -> ModelWorkCoordinator:
    global _COORDINATOR
    if _COORDINATOR is None:
        with _COORDINATOR_LOCK:
            if _COORDINATOR is None:
                _COORDINATOR = ModelWorkCoordinator(
                    resource_widths={LOCAL_GPU_RESOURCE: _configured_lease_width()},
                )
    return _COORDINATOR


def reset_model_work_coordinator() -> ModelWorkCoordinator:
    """Replace the singleton. Tests only."""

    global _COORDINATOR
    with _COORDINATOR_LOCK:
        _COORDINATOR = ModelWorkCoordinator(
            resource_widths={LOCAL_GPU_RESOURCE: _configured_lease_width()},
        )
    return _COORDINATOR


def _configured_lease_width() -> int:
    # Width stays 1 by default: total VRAM cannot establish that two arbitrary
    # workloads fit, so a VRAM-derived default is not sound. The override is an
    # expert setting, documented as unsafe without per-job resource estimates.
    from services.runtime_settings import get_model_work_lease_width

    return get_model_work_lease_width()


__all__ = [
    "CoordinatorNotReadyError",
    "JobStatus",
    "LEDGER_GAP",
    "LOCAL_GPU_RESOURCE",
    "Lease",
    "LeaseAbandonedError",
    "LeaseInvalidError",
    "LeaseTimeoutError",
    "LedgerEntry",
    "LedgerEvent",
    "LedgerSnapshot",
    "LedgerStream",
    "ModelWorkCoordinator",
    "ModelWorkError",
    "MonitorToken",
    "OccupancyState",
    "PersistedOccupancy",
    "ResourceView",
    "TENANT_BACKEND",
    "TENANT_COMFYUI",
    "TerminalVerdict",
    "comfy_resource_key",
    "get_model_work_coordinator",
    "is_comfyui_gpu_local",
    "release_cuda_cache",
    "reset_model_work_coordinator",
    "run_with_lease",
]
