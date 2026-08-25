"""Explicit runtime load tests executed through the shared job lifecycle."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from typing import Any

from config import RUNTIME_ROOT
from services.jobs import (
    BackendJobCancelledError,
    BackendJobContext,
    BackendJobDefinition,
    BackendJobManager,
    BackendJobNotFoundError,
    BackendJobNotReadyError,
    BackendJobSnapshot,
    JobArtifactStore,
)
from services.model_work.local_inference import local_gpu_lease

from . import get_capability, get_provider
from .failures import (
    get_last_failure,
    note_capability_success,
    record_exception,
)
from .observations import set_capability_checking
from .providers import CapabilityProvider
from .subprocess_probe import invalidate_probe_cache


PROBE_JOB_OWNER = "vlo.runtime-capabilities"
PROBE_JOB_OWNER_VERSION = "1"
PROBE_JOB_TYPE = "load-runtime"
PROBE_JOB_TIMEOUT_SECONDS = 20 * 60.0


class CapabilityProbeNotFoundError(BackendJobNotFoundError):
    """The capability or its probe job does not exist."""


class CapabilityProbeNotReadyError(BackendJobNotReadyError):
    """Static evidence already says loading should not be attempted."""


def _run_probe_job(context: BackendJobContext, value: object) -> object:
    if not isinstance(value, dict) or not isinstance(value.get("capabilityId"), str):
        raise CapabilityProbeNotFoundError("Capability probe input is invalid")

    capability_id = value["capabilityId"]
    provider = get_provider(capability_id)
    if provider is None:
        raise CapabilityProbeNotFoundError(
            f"Unknown runtime capability '{capability_id}'"
        )

    set_capability_checking(capability_id, True)
    try:
        return _run_checked_probe(context, capability_id, provider)
    finally:
        set_capability_checking(capability_id, False)


def _run_checked_probe(
    context: BackendJobContext,
    capability_id: str,
    provider: CapabilityProvider,
) -> object:
    invalidate_probe_cache(capability_id)
    context.report_progress(0.05, f"Preparing {provider.label} load test")

    def report_progress(progress: float, message: str) -> None:
        # Provider progress leaves room for job setup and result publication.
        normalized = min(0.9, max(0.1, float(progress)))
        context.report_progress(normalized, message)

    def load() -> Mapping[str, Any]:
        previous_failure = get_last_failure(capability_id)
        try:
            return provider.load_runtime(report_progress)
        except BackendJobCancelledError:
            raise
        except Exception as exc:
            # SAM2/SAM-Audio/Beat This! record at their exact load boundary,
            # preserving typed causes and per-device details. Only providers
            # without that integration (currently ComfyUI) need the adapter to
            # create a record.
            record = get_last_failure(capability_id)
            if record is None or record is previous_failure:
                record = record_exception(capability_id, exc)
            detail = record.detail
            suffix = (
                f": {detail}"
                if detail and detail.strip().casefold() != record.summary.strip().casefold()
                else ""
            )
            raise RuntimeError(f"{record.summary}{suffix}") from None

    if provider.uses_local_gpu:
        # Admission failures describe contention, not runtime health. Keep
        # acquisition outside ``load`` so a 120-second lease timeout fails
        # this job without poisoning the capability's lastFailure.
        with local_gpu_lease(
            source=f"runtime-probe:{capability_id}",
            label=f"Test {provider.label} runtime",
            owner=PROBE_JOB_OWNER,
        ):
            result = load()
    else:
        result = load()

    resolved_device = result.get("resolvedDevice")
    note_capability_success(
        capability_id,
        resolved_device=(resolved_device if isinstance(resolved_device, str) else None),
        detail=f"Explicit {provider.label} load test passed",
    )
    context.report_progress(0.95, f"{provider.label} loaded successfully")
    return {
        "capabilityId": capability_id,
        "loaded": True,
        "details": dict(result),
    }


class RuntimeCapabilityProbeJobs:
    """Owner-scoped probe jobs with one active job per capability."""

    def __init__(self, manager: BackendJobManager) -> None:
        self._manager = manager
        self._lock = threading.RLock()
        self._active_jobs: dict[str, str] = {}
        self._pending_submissions: dict[str, asyncio.Task[BackendJobSnapshot]] = {}

    async def submit(self, capability_id: str) -> BackendJobSnapshot:
        provider = get_provider(capability_id)
        if provider is None:
            raise CapabilityProbeNotFoundError(
                f"Unknown runtime capability '{capability_id}'"
            )

        capability = get_capability(capability_id, deep_probe=False)
        if capability is None:
            raise CapabilityProbeNotFoundError(
                f"Unknown runtime capability '{capability_id}'"
            )
        if not capability.can_attempt:
            failure = next(
                (check for check in capability.checks if check.failed),
                None,
            )
            message = (
                failure.summary
                if failure is not None
                else f"{provider.label} is not installed or configured"
            )
            raise CapabilityProbeNotReadyError(message)

        with self._lock:
            active = self._active_snapshot_locked(capability_id)
            if active is not None:
                return active
            pending = self._pending_submissions.get(capability_id)
            if pending is None:
                pending = asyncio.create_task(
                    self._submit_new(capability_id),
                    name=f"runtime-capability-submit-{capability_id}",
                )
                self._pending_submissions[capability_id] = pending
                pending.add_done_callback(
                    lambda completed, id_=capability_id: self._discard_pending(
                        id_, completed
                    )
                )

        return await asyncio.shield(pending)

    def _discard_pending(
        self,
        capability_id: str,
        completed: asyncio.Task[BackendJobSnapshot],
    ) -> None:
        with self._lock:
            if self._pending_submissions.get(capability_id) is completed:
                self._pending_submissions.pop(capability_id, None)

    async def _submit_new(self, capability_id: str) -> BackendJobSnapshot:
        snapshot = await self._manager.submit(
            PROBE_JOB_OWNER,
            PROBE_JOB_TYPE,
            {"capabilityId": capability_id},
        )
        with self._lock:
            self._active_jobs[capability_id] = snapshot.identity.job_id
        return snapshot

    def get(self, capability_id: str, job_id: str) -> BackendJobSnapshot:
        snapshot = self._manager.get(PROBE_JOB_OWNER, job_id)
        input_value = self._manager.get_input(PROBE_JOB_OWNER, job_id)
        if (
            not isinstance(input_value, dict)
            or input_value.get("capabilityId") != capability_id
        ):
            raise CapabilityProbeNotFoundError(
                f"Runtime probe job '{job_id}' was not found for '{capability_id}'"
            )
        return snapshot

    def _active_snapshot_locked(
        self, capability_id: str
    ) -> BackendJobSnapshot | None:
        job_id = self._active_jobs.get(capability_id)
        if job_id is None:
            return None
        try:
            snapshot = self._manager.get(PROBE_JOB_OWNER, job_id)
        except BackendJobNotFoundError:
            self._active_jobs.pop(capability_id, None)
            return None
        if snapshot.status in {"queued", "running"}:
            return snapshot
        self._active_jobs.pop(capability_id, None)
        return None

    async def shutdown(self) -> None:
        await self._manager.shutdown_all()


def _create_probe_jobs() -> RuntimeCapabilityProbeJobs:
    manager = BackendJobManager(
        JobArtifactStore(RUNTIME_ROOT / "runtime-capability-job-artifacts"),
        max_jobs_per_owner=32,
        executor_max_workers=4,
        max_concurrent_jobs_per_owner=4,
        evict_finished_jobs_at_capacity=True,
        thread_name_prefix="runtime-capability-job",
    )
    manager.register_owner(
        PROBE_JOB_OWNER,
        PROBE_JOB_OWNER_VERSION,
        (
            BackendJobDefinition(
                id=PROBE_JOB_TYPE,
                label="Test AI runtime",
                run=_run_probe_job,
                timeout_seconds=PROBE_JOB_TIMEOUT_SECONDS,
            ),
        ),
    )
    return RuntimeCapabilityProbeJobs(manager)


_PROBE_JOBS: RuntimeCapabilityProbeJobs | None = None
_PROBE_JOBS_LOCK = threading.Lock()


def get_runtime_capability_probe_jobs() -> RuntimeCapabilityProbeJobs:
    global _PROBE_JOBS
    if _PROBE_JOBS is None:
        with _PROBE_JOBS_LOCK:
            if _PROBE_JOBS is None:
                _PROBE_JOBS = _create_probe_jobs()
    return _PROBE_JOBS


async def shutdown_runtime_capability_probe_jobs() -> None:
    global _PROBE_JOBS
    with _PROBE_JOBS_LOCK:
        jobs = _PROBE_JOBS
        _PROBE_JOBS = None
    if jobs is not None:
        await jobs.shutdown()
