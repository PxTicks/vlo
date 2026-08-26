"""Owner-neutral lifecycle for trusted host and extension backend jobs."""

from __future__ import annotations

import asyncio
from concurrent.futures import Executor, ThreadPoolExecutor
from contextlib import nullcontext
from functools import partial
import inspect
import json
import math
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal
from uuid import uuid4

from services.jobs.artifacts import (
    JobArtifactRecord,
    JobArtifactStore,
)
from services.model_work import get_model_work_coordinator
from services.model_work.leases import Lease, LeaseAbandonedError
from services.model_work.ledger import LOCAL_GPU_RESOURCE, TerminalVerdict
from services.model_work.local_inference import hold_local_gpu, reserve_local_gpu


DEFAULT_FINISHED_JOB_TTL_SECONDS = 15 * 60
DEFAULT_UNCLAIMED_ARTIFACT_TTL_SECONDS = 15 * 60
DEFAULT_MAX_JOBS_PER_OWNER = 64
DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_OWNER = 32
# Public extension imports retain these names through the compatibility facade.
DEFAULT_MAX_JOBS_PER_EXTENSION = DEFAULT_MAX_JOBS_PER_OWNER
DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_EXTENSION = (
    DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_OWNER
)
DEFAULT_JOB_VALIDATION_TIMEOUT_SECONDS = 5.0
DEFAULT_JOB_TIMEOUT_SECONDS = 15 * 60.0
DEFAULT_MAX_JOB_DIAGNOSTICS = 100
#: How long a GPU job waits for admission before failing. Generous on purpose:
#: waiting is the normal state of a queue, and the alternative to waiting is
#: two models resident at once. Cancellation is what shortens it, not a small
#: timeout. Execution's own timeout starts only once the job is admitted.
DEFAULT_ADMISSION_WAIT_SECONDS = 30 * 60.0
#: Ledger statuses that represent a decision about a job, as opposed to the
#: success a released lease reports when nothing has gone wrong.
_DECIDED_JOB_STATUSES = frozenset({"failed", "cancelled"})

_CONTRIBUTION_ID_PATTERN = re.compile(
    r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$"
)

BackendJobStatus = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
]
BackendJobDiagnosticLevel = Literal["debug", "info", "warning", "error"]
BackendJobValidator = Callable[[object], object | Awaitable[object]]
BackendJobRunner = Callable[
    ["BackendJobContext", object],
    object | Awaitable[object],
]
BackendJobReadinessCallback = Callable[
    [],
    "BackendJobReadiness | Awaitable[BackendJobReadiness]",
]


class BackendJobError(RuntimeError):
    """Base error for the shared backend job lifecycle."""


class BackendJobNotFoundError(BackendJobError):
    """Raised for unknown job types or instances."""


class BackendJobValidationError(BackendJobError):
    """Raised when job input or result validation fails."""


class BackendJobNotReadyError(BackendJobError):
    """Raised when a declared model/service dependency is not ready."""


class BackendJobCapacityError(BackendJobError):
    """Raised when an owner has too many retained or running jobs."""


class BackendJobCancelledError(BackendJobError):
    """Cooperative cancellation signal available to job handlers."""


@dataclass(frozen=True)
class BackendJobReadiness:
    ready: bool
    message: str
    details: object | None = None

    @classmethod
    def available(cls, message: str = "Ready") -> "BackendJobReadiness":
        return cls(ready=True, message=message)

    @classmethod
    def unavailable(
        cls,
        message: str,
        *,
        details: object | None = None,
    ) -> "BackendJobReadiness":
        return cls(ready=False, message=message, details=details)

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "ready": self.ready,
            "message": self.message,
        }
        if self.details is not None:
            payload["details"] = _clone_json(self.details)
        return payload


@dataclass(frozen=True)
class BackendJobDefinition:
    id: str
    label: str
    run: BackendJobRunner
    validate_input: BackendJobValidator | None = None
    validate_result: BackendJobValidator | None = None
    readiness: BackendJobReadinessCallback | None = None
    timeout_seconds: float = DEFAULT_JOB_TIMEOUT_SECONDS
    #: This job runs a model on the local GPU, so it must hold ``local-gpu``
    #: for the whole of its physical execution. The manager takes the lease —
    #: a job that volunteered for admission would be a job that could forget,
    #: which is the failure this whole seam exists to remove. Only a manager
    #: configured with a ``work_source`` may carry such definitions, and the
    #: runner must be synchronous: the lease belongs to the worker thread that
    #: runs the model, even though the *wait* for it happens on the loop.
    uses_local_gpu: bool = False


@dataclass(frozen=True)
class BackendJobIdentity:
    owner_id: str
    owner_version: str
    job_id: str
    job_type: str

    @property
    def extension_id(self) -> str:
        """Compatibility alias used by extension job handlers."""

        return self.owner_id

    @property
    def extension_version(self) -> str:
        """Compatibility alias used by extension job handlers."""

        return self.owner_version


@dataclass(frozen=True)
class BackendJobDiagnostic:
    level: BackendJobDiagnosticLevel
    message: str
    timestamp: float
    detail: object | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "level": self.level,
            "message": self.message,
            "timestamp": self.timestamp,
        }
        if self.detail is not None:
            payload["detail"] = _clone_json(self.detail)
        return payload


@dataclass(frozen=True)
class BackendJobSnapshot:
    identity: BackendJobIdentity
    status: BackendJobStatus
    progress: float
    message: str
    cancel_requested: bool
    created_at: float
    updated_at: float
    result: object | None
    error: str | None
    artifacts: tuple[JobArtifactRecord, ...]
    diagnostics: tuple[BackendJobDiagnostic, ...]
    runtime_metadata: object | None = field(
        default=None,
        repr=False,
        compare=False,
    )

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "jobId": self.identity.job_id,
            "jobType": self.identity.job_type,
            "extensionId": self.identity.owner_id,
            "extensionVersion": self.identity.owner_version,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "cancelRequested": self.cancel_requested,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            "diagnostics": [diagnostic.to_dict() for diagnostic in self.diagnostics],
        }
        if self.result is not None:
            payload["result"] = _clone_json(self.result)
        if self.error is not None:
            payload["error"] = self.error
        return payload


@dataclass
class _BackendJobRecord:
    identity: BackendJobIdentity
    definition: BackendJobDefinition
    input_value: object
    input_artifact_ids: tuple[str, ...]
    status: BackendJobStatus = "queued"
    progress: float = 0.0
    message: str = "Queued"
    cancel_requested: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    result: object | None = None
    error: str | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    diagnostics: list[BackendJobDiagnostic] = field(default_factory=list)
    runtime_metadata: object | None = None
    #: Held only while the worker callable is physically executing, so the
    #: queue can show this job's progress and mark it `stopping` on cancel.
    lease: "Lease | None" = None
    #: The ledger entry this job reserved, kept after the lease is gone. A job
    #: can still become terminal after release — result validation is the
    #: ordinary case — and the entry is retained as queue history, so it can
    #: and must be corrected rather than left claiming success.
    ledger_entry_id: str | None = None


class BackendJobArtifactAccess:
    def __init__(
        self,
        store: JobArtifactStore,
        identity: BackendJobIdentity,
        input_artifact_ids: tuple[str, ...],
        cancel_event: threading.Event,
    ) -> None:
        self._store = store
        self._identity = identity
        self._input_artifact_ids = frozenset(input_artifact_ids)
        self._cancel_event = cancel_event

    @property
    def input_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._input_artifact_ids))

    def read(self, artifact_id: str) -> bytes:
        if artifact_id not in self._input_artifact_ids:
            raise BackendJobValidationError(
                f"artifact '{artifact_id}' was not supplied to this job"
            )
        return self._store.read_for_job(
            self._identity.owner_id,
            self._identity.job_id,
            artifact_id,
        )

    def create(
        self,
        content: bytes,
        *,
        filename: str,
        content_type: str = "application/octet-stream",
    ) -> JobArtifactRecord:
        if self._cancel_event.is_set():
            raise BackendJobCancelledError("job cancellation was requested")
        return self._store.create_output(
            self._identity.owner_id,
            self._identity.job_id,
            content,
            filename=filename,
            content_type=content_type,
        )


class BackendJobContext:
    def __init__(
        self,
        identity: BackendJobIdentity,
        cancel_event: threading.Event,
        artifacts: BackendJobArtifactAccess,
        report_progress: Callable[[float, str], None],
        report_diagnostic: Callable[
            [BackendJobDiagnosticLevel, str, object | None], None
        ],
        report_runtime_metadata: Callable[[object], None] | None = None,
    ) -> None:
        self.identity = identity
        self.artifacts = artifacts
        self._cancel_event = cancel_event
        self._report_progress = report_progress
        self._report_diagnostic = report_diagnostic
        self._report_runtime_metadata = report_runtime_metadata or (
            lambda _metadata: None
        )

    @property
    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise BackendJobCancelledError("job cancellation was requested")

    def report_progress(self, progress: float, message: str) -> None:
        self.raise_if_cancelled()
        self._report_progress(progress, message)

    def report_diagnostic(
        self,
        level: BackendJobDiagnosticLevel,
        message: str,
        detail: object | None = None,
    ) -> None:
        self.raise_if_cancelled()
        self._report_diagnostic(level, message, detail)

    def report_runtime_metadata(self, metadata: object) -> None:
        """Publish finite-JSON host metadata without changing the public result."""

        self.raise_if_cancelled()
        self._report_runtime_metadata(metadata)


def _clone_json(value: object) -> object:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return json.loads(encoded)
    except (TypeError, ValueError) as exc:
        raise BackendJobValidationError("value must be finite JSON") from exc


async def _invoke_callback(
    callback: Callable[..., object],
    *args: object,
    timeout: float | None = None,
    offload_sync: bool = False,
    executor: Executor | None = None,
) -> object:
    async def invoke() -> object:
        if inspect.iscoroutinefunction(callback):
            return await callback(*args)
        if offload_sync:
            loop = asyncio.get_running_loop()
            value = await loop.run_in_executor(executor, partial(callback, *args))
        else:
            value = callback(*args)
        if inspect.isawaitable(value):
            return await value
        return value

    if timeout is None:
        return await invoke()
    return await asyncio.wait_for(invoke(), timeout=timeout)


def _consume_future_exception(future: asyncio.Future[object]) -> None:
    if not future.cancelled():
        future.exception()


class BackendJobManager:
    def __init__(
        self,
        artifacts: JobArtifactStore,
        *,
        finished_ttl_seconds: float = DEFAULT_FINISHED_JOB_TTL_SECONDS,
        unclaimed_artifact_ttl_seconds: float = (
            DEFAULT_UNCLAIMED_ARTIFACT_TTL_SECONDS
        ),
        max_jobs_per_owner: int = DEFAULT_MAX_JOBS_PER_EXTENSION,
        max_unclaimed_artifacts_per_owner: int = (
            DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_EXTENSION
        ),
        validation_timeout_seconds: float = (
            DEFAULT_JOB_VALIDATION_TIMEOUT_SECONDS
        ),
        executor_max_workers: int = 4,
        max_concurrent_jobs_per_owner: int | None = None,
        evict_finished_jobs_at_capacity: bool = False,
        thread_name_prefix: str = "vlo-backend-job",
        max_jobs_per_extension: int | None = None,
        max_unclaimed_artifacts_per_extension: int | None = None,
        work_source: str | None = None,
        admission_wait_seconds: float = DEFAULT_ADMISSION_WAIT_SECONDS,
        now: Callable[[], float] = time.time,
    ) -> None:
        if max_jobs_per_extension is not None:
            max_jobs_per_owner = max_jobs_per_extension
        if max_unclaimed_artifacts_per_extension is not None:
            max_unclaimed_artifacts_per_owner = (
                max_unclaimed_artifacts_per_extension
            )
        if finished_ttl_seconds <= 0 or unclaimed_artifact_ttl_seconds <= 0:
            raise ValueError("job TTLs must be positive")
        if max_jobs_per_owner <= 0:
            raise ValueError("max_jobs_per_owner must be positive")
        if max_unclaimed_artifacts_per_owner <= 0:
            raise ValueError(
                "max_unclaimed_artifacts_per_owner must be positive"
            )
        if validation_timeout_seconds <= 0:
            raise ValueError("validation_timeout_seconds must be positive")
        if executor_max_workers <= 0:
            raise ValueError("executor_max_workers must be positive")
        if admission_wait_seconds <= 0:
            raise ValueError("admission_wait_seconds must be positive")
        if (
            max_concurrent_jobs_per_owner is not None
            and max_concurrent_jobs_per_owner <= 0
        ):
            raise ValueError(
                "max_concurrent_jobs_per_owner must be positive when provided"
            )
        self._artifacts = artifacts
        self._finished_ttl_seconds = finished_ttl_seconds
        self._unclaimed_artifact_ttl_seconds = unclaimed_artifact_ttl_seconds
        self._max_jobs_per_owner = max_jobs_per_owner
        self._max_unclaimed_artifacts_per_owner = (
            max_unclaimed_artifacts_per_owner
        )
        self._validation_timeout_seconds = validation_timeout_seconds
        # What the ledger calls this manager's work. Set it and jobs may
        # declare `uses_local_gpu`; leave it unset and such a definition is
        # refused at registration, because an entry with no source is one the
        # queue panel cannot attribute to anyone.
        self._work_source = work_source
        self._admission_wait_seconds = admission_wait_seconds
        self._now = now
        self._lock = threading.RLock()
        self._definitions: dict[str, dict[str, BackendJobDefinition]] = {}
        self._owner_versions: dict[str, str] = {}
        self._jobs: dict[str, _BackendJobRecord] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._max_concurrent_jobs_per_owner = max_concurrent_jobs_per_owner
        self._evict_finished_jobs_at_capacity = evict_finished_jobs_at_capacity
        self._owner_semaphores: dict[str, asyncio.Semaphore] = {}
        self._thread_name_prefix = thread_name_prefix
        self._executor = ThreadPoolExecutor(
            max_workers=executor_max_workers,
            thread_name_prefix=thread_name_prefix,
        )
        # GPU jobs run on their own pool, created on first use. Two reasons,
        # and both are about who waits where: an admitted job must not then
        # queue behind CPU work for a thread, holding the card idle; and CPU
        # jobs must not queue behind it either. See `_gpu_worker_pool`.
        self._gpu_executor: ThreadPoolExecutor | None = None
        self._closed = False

    @property
    def artifacts(self) -> JobArtifactStore:
        return self._artifacts

    def register_owner(
        self,
        owner_id: str,
        owner_version: str,
        definitions: tuple[BackendJobDefinition, ...],
    ) -> None:
        validated: dict[str, BackendJobDefinition] = {}
        for definition in definitions:
            self._validate_definition(definition)
            if definition.uses_local_gpu:
                self._validate_gpu_definition(definition)
            if definition.id in validated:
                raise BackendJobValidationError(
                    f"duplicate backend job type '{definition.id}'"
                )
            validated[definition.id] = definition
        with self._lock:
            if self._closed:
                raise BackendJobError("backend job manager is closed")
            if owner_id in self._definitions:
                raise BackendJobValidationError(
                    f"backend jobs for '{owner_id}' are already registered"
                )
            self._definitions[owner_id] = validated
            self._owner_versions[owner_id] = owner_version
            if self._max_concurrent_jobs_per_owner is not None:
                self._owner_semaphores[owner_id] = asyncio.Semaphore(
                    self._max_concurrent_jobs_per_owner
                )

    def _validate_gpu_definition(self, definition: BackendJobDefinition) -> None:
        """A GPU job must be admissible and must own a thread while it runs."""

        if self._work_source is None:
            raise BackendJobValidationError(
                f"backend job '{definition.id}' declares uses_local_gpu, but "
                "this job manager has no work_source and cannot reserve the "
                "local GPU"
            )
        if inspect.iscoroutinefunction(definition.run):
            # The lease is released by the thread that ran the model, when the
            # physical call returns. An async runner hands its work back to the
            # event loop, so the release would race the model still resident.
            raise BackendJobValidationError(
                f"backend job '{definition.id}' declares uses_local_gpu, so "
                "its run callable must be synchronous"
            )

    def unregister_owner(self, owner_id: str) -> None:
        with self._lock:
            self._definitions.pop(owner_id, None)
            self._owner_versions.pop(owner_id, None)

    def register_extension(
        self,
        extension_id: str,
        extension_version: str,
        definitions: tuple[BackendJobDefinition, ...],
    ) -> None:
        """Compatibility facade for the public extension host."""

        self.register_owner(extension_id, extension_version, definitions)

    def unregister_extension(self, extension_id: str) -> None:
        """Compatibility facade for the public extension host."""

        self.unregister_owner(extension_id)

    def is_registered(self, owner_id: str) -> bool:
        with self._lock:
            return owner_id in self._definitions

    async def list_job_types(self, owner_id: str) -> tuple[dict[str, object], ...]:
        with self._lock:
            definitions = tuple(self._get_definitions(owner_id).values())
        result: list[dict[str, object]] = []
        for definition in definitions:
            readiness = await self._get_readiness(definition)
            result.append(
                {
                    "id": definition.id,
                    "label": definition.label,
                    "timeoutSeconds": definition.timeout_seconds,
                    "usesLocalGpu": definition.uses_local_gpu,
                    "readiness": readiness.to_dict(),
                }
            )
        return tuple(result)

    def upload_input(
        self,
        owner_id: str,
        content: bytes,
        *,
        filename: str,
        content_type: str,
    ) -> JobArtifactRecord:
        with self._lock:
            definitions = self._get_definitions(owner_id)
            if not definitions:
                raise BackendJobNotFoundError(
                    f"backend job owner '{owner_id}' has no registered jobs"
                )
            self._evict_locked()
            if (
                self._artifacts.count_unclaimed(owner_id)
                >= self._max_unclaimed_artifacts_per_owner
            ):
                raise BackendJobCapacityError(
                    f"job owner '{owner_id}' has reached its unclaimed artifact limit"
                )
            return self._artifacts.create_input(
                owner_id,
                content,
                filename=filename,
                content_type=content_type,
            )

    async def submit(
        self,
        owner_id: str,
        job_type: str,
        input_value: object,
        input_artifact_ids: tuple[str, ...] = (),
    ) -> BackendJobSnapshot:
        with self._lock:
            definitions = self._get_definitions(owner_id)
            definition = definitions.get(job_type)
            owner_version = self._owner_versions[owner_id]
        if definition is None:
            raise BackendJobNotFoundError(
                f"backend job type '{owner_id}/{job_type}' was not found"
            )
        readiness = await self._get_readiness(definition)
        if not readiness.ready:
            raise BackendJobNotReadyError(readiness.message)

        normalized_input = _clone_json(input_value)
        if definition.validate_input is not None:
            try:
                normalized_input = await _invoke_callback(
                    definition.validate_input,
                    normalized_input,
                    timeout=self._validation_timeout_seconds,
                )
                normalized_input = _clone_json(normalized_input)
            except BackendJobValidationError:
                raise
            except Exception as exc:
                raise BackendJobValidationError(
                    f"backend job input is invalid: {exc}"
                ) from exc

        job_id = uuid4().hex
        identity = BackendJobIdentity(
            owner_id=owner_id,
            owner_version=owner_version,
            job_id=job_id,
            job_type=job_type,
        )
        now = float(self._now())
        record = _BackendJobRecord(
            identity=identity,
            definition=definition,
            input_value=normalized_input,
            input_artifact_ids=tuple(input_artifact_ids),
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._get_definitions(owner_id)
            self._evict_locked()
            if self._evict_finished_jobs_at_capacity:
                self._evict_finished_for_capacity_locked(owner_id)
            retained = sum(
                1
                for candidate in self._jobs.values()
                if candidate.identity.owner_id == owner_id
            )
            if retained >= self._max_jobs_per_owner:
                raise BackendJobCapacityError(
                    f"job owner '{owner_id}' has reached its job limit"
                )
            self._artifacts.claim_inputs(
                owner_id,
                job_id,
                tuple(input_artifact_ids),
            )
            self._jobs[job_id] = record
            task = asyncio.create_task(
                self._run_job(record),
                name=f"vlo-backend-job-{owner_id}-{job_id}",
            )
            self._tasks[job_id] = task
            return self._snapshot_locked(record)

    def get(self, owner_id: str, job_id: str) -> BackendJobSnapshot:
        with self._lock:
            self._evict_locked()
            return self._snapshot_locked(self._get_job(owner_id, job_id))

    def list_jobs(self, owner_id: str) -> tuple[BackendJobSnapshot, ...]:
        """Return retained jobs for an owner, oldest first."""

        with self._lock:
            self._get_definitions(owner_id)
            self._evict_locked()
            return tuple(
                self._snapshot_locked(record)
                for record in sorted(
                    (
                        candidate
                        for candidate in self._jobs.values()
                        if candidate.identity.owner_id == owner_id
                    ),
                    key=lambda candidate: candidate.created_at,
                )
            )

    def get_input(self, owner_id: str, job_id: str) -> object:
        """Return the normalized finite-JSON input retained for a job."""

        with self._lock:
            return _clone_json(self._get_job(owner_id, job_id).input_value)

    async def cancel(self, owner_id: str, job_id: str) -> BackendJobSnapshot:
        task: asyncio.Task[None] | None
        with self._lock:
            record = self._get_job(owner_id, job_id)
            if record.status in ("succeeded", "failed", "cancelled"):
                return self._snapshot_locked(record)
            record.cancel_requested = True
            record.cancel_event.set()
            record.message = "Cancellation requested"
            record.updated_at = float(self._now())
            # Publicly cancelled, physically still resident: the ledger says
            # `stopping` until the worker callable actually returns.
            self._settle_ledger(
                record,
                job_status="cancelled",
                message="Cancellation requested",
            )
            task = self._tasks.get(job_id)
            if task is not None:
                task.cancel()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        with self._lock:
            record = self._get_job(owner_id, job_id)
            if record.status not in ("succeeded", "failed", "cancelled"):
                self._finish_cancelled_locked(record)
            self._tasks.pop(job_id, None)
            return self._snapshot_locked(record)

    def get_artifact(
        self,
        owner_id: str,
        artifact_id: str,
    ) -> tuple[JobArtifactRecord, bytes]:
        with self._lock:
            self._get_definitions(owner_id)
        artifact, content = self._artifacts.get_for_delivery(owner_id, artifact_id)
        if artifact.job_id is not None:
            with self._lock:
                record = self._jobs.get(artifact.job_id)
                if record is not None and record.identity.owner_id == owner_id:
                    record.updated_at = float(self._now())
        return artifact, content

    async def shutdown_owner(self, owner_id: str) -> None:
        with self._lock:
            self.unregister_owner(owner_id)
            records = [
                record
                for record in self._jobs.values()
                if record.identity.owner_id == owner_id
            ]
            tasks = [
                task
                for record in records
                if (task := self._tasks.get(record.identity.job_id)) is not None
            ]
            for record in records:
                record.cancel_requested = True
                record.cancel_event.set()
                # The job record is about to be dropped entirely. Without this
                # its entry would outlive it and release as a succeeded job
                # belonging to an extension that is no longer loaded.
                self._settle_ledger(
                    record,
                    job_status="cancelled",
                    message="Owner shut down",
                )
            for task in tasks:
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        with self._lock:
            for record in records:
                self._jobs.pop(record.identity.job_id, None)
                self._tasks.pop(record.identity.job_id, None)
            self._owner_semaphores.pop(owner_id, None)
        self._artifacts.remove_owner(owner_id)

    async def shutdown_extension(self, extension_id: str) -> None:
        """Compatibility facade for the public extension host."""

        await self.shutdown_owner(extension_id)

    async def shutdown_all(self) -> None:
        with self._lock:
            owner_ids = tuple(self._definitions)
        for owner_id in reversed(owner_ids):
            await self.shutdown_owner(owner_id)
        with self._lock:
            if self._closed:
                return
            self._closed = True
            gpu_executor = self._gpu_executor
        self._executor.shutdown(wait=False, cancel_futures=True)
        if gpu_executor is not None:
            gpu_executor.shutdown(wait=False, cancel_futures=True)

    async def _run_job(self, record: _BackendJobRecord) -> None:
        identity = record.identity
        semaphore = self._owner_semaphores.get(identity.owner_id)
        acquired = False
        try:
            if semaphore is not None:
                await semaphore.acquire()
                acquired = True
            context = BackendJobContext(
                identity,
                record.cancel_event,
                BackendJobArtifactAccess(
                    self._artifacts,
                    identity,
                    record.input_artifact_ids,
                    record.cancel_event,
                ),
                lambda progress, message: self._report_progress(
                    identity.job_id,
                    progress,
                    message,
                ),
                lambda level, message, detail: self._report_diagnostic(
                    identity.job_id,
                    level,
                    message,
                    detail,
                ),
                lambda metadata: self._report_runtime_metadata(
                    identity.job_id,
                    metadata,
                ),
            )
            context.raise_if_cancelled()
            result = await self._invoke_runner(record, context)
            context.raise_if_cancelled()
            result = _clone_json(result)
            if record.definition.validate_result is not None:
                try:
                    result = await _invoke_callback(
                        record.definition.validate_result,
                        result,
                        timeout=self._validation_timeout_seconds,
                    )
                except TimeoutError as exc:
                    raise BackendJobValidationError(
                        "backend job result validation timed out"
                    ) from exc
                result = _clone_json(result)
            context.raise_if_cancelled()
            with self._lock:
                record.status = "succeeded"
                record.progress = 1.0
                record.message = "Completed"
                record.result = result
                record.updated_at = float(self._now())
        except TimeoutError:
            record.cancel_event.set()
            with self._lock:
                # A non-cooperative runner can return normally long after this;
                # without a terminal ledger status its entry would release as
                # succeeded while the job says it timed out.
                self._settle_ledger(record, job_status="failed", message="Timed out")
                record.status = "failed"
                record.progress = 1.0
                record.message = "Timed out"
                record.error = (
                    f"job exceeded its {record.definition.timeout_seconds:g} "
                    "second timeout"
                )
                record.updated_at = float(self._now())
        except (
            asyncio.CancelledError,
            BackendJobCancelledError,
            # A runner that waits for the GPU itself, with this job's cancel
            # event as its stop: abandoning that wait is this job's own
            # cancellation arriving, not a failure of the work. The manager's
            # admission wait is cancelled through the task instead.
            LeaseAbandonedError,
        ):
            with self._lock:
                self._settle_ledger(
                    record,
                    job_status="cancelled",
                    message="Cancelled",
                )
                self._finish_cancelled_locked(record)
        except Exception as exc:
            with self._lock:
                # Result validation runs after the lease is released, so an
                # invalid result would otherwise leave a succeeded entry behind
                # a failed job.
                self._settle_ledger(record, job_status="failed", message="Failed")
                record.status = "failed"
                record.progress = 1.0
                record.message = "Failed"
                record.error = str(exc)
                record.updated_at = float(self._now())
        finally:
            if acquired and semaphore is not None:
                semaphore.release()
            with self._lock:
                self._tasks.pop(identity.job_id, None)

    async def _reserve_gpu(self, record: _BackendJobRecord) -> Lease | None:
        """Wait for `local-gpu` on the event loop, or `None` for a CPU job.

        The wait used to happen on the worker thread that would go on to run
        the model, because the lease must belong to that thread. It does not
        have to *start* there: four queued GPU jobs would fill a four-thread
        pool and delay an unrelated extension's CPU job, so only the ownership
        is thread-bound, and it is taken at dispatch instead.

        Cancelling the job cancels the task awaiting this, which drops the
        waiting entry — a cancelled job leaves the queue rather than keeping
        its place until it is admitted to work nobody wants any more.

        Owner and source come from the manager and the job's identity, never
        from the definition: an extension names its own job, not its place in
        the machine's queue.
        """

        if not record.definition.uses_local_gpu or self._work_source is None:
            return None
        identity = record.identity
        return await reserve_local_gpu(
            source=self._work_source,
            label=f"{record.definition.label} ({identity.owner_id})",
            owner=identity.owner_id,
            timeout=self._admission_wait_seconds,
        )

    def _gpu_worker_pool(self) -> Executor:
        """The pool admitted GPU jobs run on, sized to what may be admitted.

        Separate from the general pool in both directions. A GPU job that had
        to queue for a general worker after admission would hold the card idle
        while it waited; a GPU job on the general pool is the head-of-line
        blocking that moving the wait off it was meant to remove.

        One thread per concurrently admissible job means admission is never
        followed by a wait for somewhere to run. The width is a runtime
        setting, so it is read at first use rather than at construction, and
        managers that never register a GPU job never spawn the pool.
        """

        with self._lock:
            if self._closed:
                raise BackendJobError("backend job manager is closed")
            if self._gpu_executor is None:
                width = get_model_work_coordinator().resource_width(
                    LOCAL_GPU_RESOURCE
                )
                self._gpu_executor = ThreadPoolExecutor(
                    max_workers=max(1, width),
                    thread_name_prefix=f"{self._thread_name_prefix}-gpu",
                )
            return self._gpu_executor

    def _release_admission(
        self,
        record: _BackendJobRecord,
        lease: Lease | None,
    ) -> None:
        """Release a lease no worker callable will ever own.

        Only for the two paths where that callable cannot run at all: the
        executor refused the submission, or the future was still pending when
        it was cancelled. Everywhere else the worker's own exit path releases,
        and this coroutine must keep its hands off — a lease released while the
        model is still resident is the bug the thread-ownership rule exists to
        prevent.
        """

        if lease is None:
            return
        self._attach_lease(record, None)
        entry = lease.entry()
        verdict: TerminalVerdict = (
            "cancelled"
            if entry is not None and entry.job_status == "cancelled"
            else "failed"
        )
        lease.release(verdict)

    def _attach_lease(self, record: _BackendJobRecord, lease: Lease | None) -> None:
        with self._lock:
            record.lease = lease
            if lease is None:
                return
            record.ledger_entry_id = lease.entry_id
            if record.cancel_event.is_set():
                # Cancelled between admission and here: the queue must say
                # `stopping` immediately, not once this thread notices.
                lease.request_stop(message="Cancellation requested")

    def _settle_ledger(
        self,
        record: _BackendJobRecord,
        *,
        job_status: TerminalVerdict,
        message: str,
    ) -> None:
        """Tell the queue what became of this job, whenever that was decided.

        The job record and the ledger entry are independent by design — one is
        a public lifecycle, the other is physical occupancy — but they may not
        *contradict* each other. Two ways they used to:

        * a job the host gave up on (timeout, shutdown) whose worker later
          returned normally released its entry as ``succeeded``;
        * a job that failed result validation had already released its entry as
          ``succeeded``, because validation runs after the callable returns.

        Called while the work is still resident, the entry becomes ``stopping``
        and terminal. Called afterwards, the retained entry is corrected. Either
        way the terminal status sticks: :meth:`release_holder` never overwrites
        one.
        """

        entry_id = record.ledger_entry_id
        if entry_id is None:
            return
        coordinator = get_model_work_coordinator()
        entry = coordinator.get_entry(entry_id)
        if entry is None or entry.job_status in _DECIDED_JOB_STATUSES:
            # The first *adverse* statement wins: an outcome does not change
            # once something has gone wrong, and a later sweep — shutting the
            # owner down over already-finished records — must not relabel it.
            #
            # `succeeded` is deliberately not in that set. It is what
            # `release_holder` writes when nothing else has spoken, so a job
            # that fails after its lease is released is correcting a default
            # rather than overwriting a verdict.
            return
        lease = record.lease
        if lease is not None:
            lease.request_stop(message=message, verdict=job_status)
            return
        coordinator.update_entry(entry_id, job_status=job_status, message=message)

    async def _invoke_runner(
        self,
        record: _BackendJobRecord,
        context: BackendJobContext,
    ) -> object:
        """Admit here, but let the worker own the lease it runs under.

        Two lifetimes, deliberately different. The *wait* for `local-gpu` is
        awaited on the loop, so a queued GPU job costs no worker thread. The
        *ownership* is handed to the physical worker callable and released in
        its `finally`, which is the one exit path every way of leaving the
        model call passes through. Releasing from this coroutine instead would
        hand the GPU over on cancellation or timeout with the model still
        resident; a `Future.add_done_callback` would not be reliable either,
        since it runs on the registering thread when the future has already
        completed, and on a cancelled future runs without the callable having
        run at all. What this coroutine may still do is mark the entry
        `stopping` and stop awaiting — see `_settle_ledger`.

        The execution timeout starts when a worker actually begins, not when
        the job was submitted: a job whose timeout ran while it sat in the
        queue would fail without ever touching the model.
        """

        lease = await self._reserve_gpu(record)
        self._attach_lease(record, lease)

        loop = asyncio.get_running_loop()
        started = asyncio.Event()

        def invoke() -> object:
            marked = False

            def mark_started() -> None:
                nonlocal marked
                if marked:
                    return
                marked = True
                loop.call_soon_threadsafe(started.set)

            # Taking ownership on this thread is also what lets nested local
            # inference inside the runner pass through instead of deadlocking
            # against its own exclusive tenant.
            holder = nullcontext(lease) if lease is None else hold_local_gpu(lease)
            try:
                with holder:
                    try:
                        try:
                            self._mark_running(record.identity.job_id)
                        finally:
                            mark_started()
                        result = record.definition.run(
                            context,
                            _clone_json(record.input_value),
                        )
                        if lease is not None and inspect.isawaitable(result):
                            # Registration refuses a coroutine function; this
                            # catches the sync callable that returns one. The
                            # lease would be released here, with the awaited
                            # work still to come and the model still resident.
                            if inspect.iscoroutine(result):
                                result.close()
                            raise BackendJobValidationError(
                                f"backend job '{record.definition.id}' declares "
                                "uses_local_gpu, so its run callable must not "
                                "return an awaitable"
                            )
                        return result
                    finally:
                        # Detach before the release below, so the record never
                        # names a lease the coordinator has already let go.
                        self._attach_lease(record, None)
            finally:
                # A job cancelled before execution is refused by
                # `_mark_running`; without this the awaiting coroutine would
                # never learn the worker had finished with it.
                mark_started()

        try:
            executor = self._executor if lease is None else self._gpu_worker_pool()
            concurrent_future = executor.submit(invoke)
        except BaseException:
            # No pool, or one that refused the submission: `invoke` will never
            # run, so nothing else can release.
            self._release_admission(record, lease)
            raise
        future = asyncio.wrap_future(concurrent_future)
        future.add_done_callback(_consume_future_exception)
        try:
            await started.wait()

            async def finish() -> object:
                value = await asyncio.shield(future)
                if inspect.isawaitable(value):
                    return await value
                return value

            return await asyncio.wait_for(
                finish(),
                timeout=record.definition.timeout_seconds,
            )
        except asyncio.CancelledError:
            if concurrent_future.cancel():
                # Cancelled while still pending: the wrapper never ran and
                # never will, so this is the one cancellation path that has to
                # release. A running worker keeps its lease, by design.
                self._release_admission(record, lease)
            raise

    def _mark_running(self, job_id: str) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.cancel_event.is_set():
                raise BackendJobCancelledError(
                    "job cancellation was requested before execution"
                )
            record.status = "running"
            record.message = "Running"
            record.updated_at = float(self._now())

    def _report_progress(self, job_id: str, progress: float, message: str) -> None:
        if not math.isfinite(progress) or progress < 0 or progress > 1:
            raise BackendJobValidationError("job progress must be between 0 and 1")
        normalized_message = message.strip()
        if not normalized_message or len(normalized_message) > 500:
            raise BackendJobValidationError(
                "job progress messages must contain 1-500 characters"
            )
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.status != "running":
                raise BackendJobCancelledError("job is no longer running")
            if record.cancel_event.is_set():
                raise BackendJobCancelledError("job cancellation was requested")
            record.progress = min(0.999999, max(record.progress, progress))
            record.message = normalized_message
            record.updated_at = float(self._now())
            if record.lease is not None:
                # The queue panel shows this entry while it holds the GPU;
                # without the mirror it would sit at "waiting" for the whole
                # run. Never fatal to the job: the ledger is a description.
                try:
                    record.lease.report(
                        progress=record.progress,
                        message=normalized_message,
                    )
                except Exception:  # pragma: no cover - defensive
                    pass

    def _report_diagnostic(
        self,
        job_id: str,
        level: BackendJobDiagnosticLevel,
        message: str,
        detail: object | None,
    ) -> None:
        if level not in ("debug", "info", "warning", "error"):
            raise BackendJobValidationError("job diagnostic level is invalid")
        normalized_message = message.strip()
        if not normalized_message or len(normalized_message) > 1000:
            raise BackendJobValidationError(
                "job diagnostic messages must contain 1-1000 characters"
            )
        normalized_detail = _clone_json(detail) if detail is not None else None
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.status != "running":
                raise BackendJobCancelledError("job is no longer running")
            if record.cancel_event.is_set():
                raise BackendJobCancelledError("job cancellation was requested")
            record.diagnostics.append(
                BackendJobDiagnostic(
                    level=level,
                    message=normalized_message,
                    detail=normalized_detail,
                    timestamp=float(self._now()),
                )
            )
            if len(record.diagnostics) > DEFAULT_MAX_JOB_DIAGNOSTICS:
                del record.diagnostics[:-DEFAULT_MAX_JOB_DIAGNOSTICS]

    def _report_runtime_metadata(self, job_id: str, metadata: object) -> None:
        normalized = _clone_json(metadata)
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.status != "running":
                raise BackendJobCancelledError("job is no longer running")
            if record.cancel_event.is_set():
                raise BackendJobCancelledError(
                    "job cancellation was requested"
                )
            record.runtime_metadata = normalized
            record.updated_at = float(self._now())

    async def _get_readiness(
        self,
        definition: BackendJobDefinition,
    ) -> BackendJobReadiness:
        if definition.readiness is None:
            return BackendJobReadiness.available()
        try:
            readiness = await _invoke_callback(
                definition.readiness,
                timeout=self._validation_timeout_seconds,
            )
        except Exception as exc:
            return BackendJobReadiness.unavailable(
                f"Readiness check failed: {exc}"
            )
        if not isinstance(readiness, BackendJobReadiness):
            return BackendJobReadiness.unavailable(
                "Readiness callback returned an invalid value"
            )
        readiness.to_dict()
        return readiness

    def _snapshot_locked(self, record: _BackendJobRecord) -> BackendJobSnapshot:
        artifacts = self._artifacts.list_for_job(
            record.identity.owner_id,
            record.identity.job_id,
            role="output",
        )
        return BackendJobSnapshot(
            identity=record.identity,
            status=record.status,
            progress=record.progress,
            message=record.message,
            cancel_requested=record.cancel_requested,
            created_at=record.created_at,
            updated_at=record.updated_at,
            result=_clone_json(record.result) if record.result is not None else None,
            error=record.error,
            artifacts=artifacts,
            diagnostics=tuple(record.diagnostics),
            runtime_metadata=(
                _clone_json(record.runtime_metadata)
                if record.runtime_metadata is not None
                else None
            ),
        )

    def _get_definitions(
        self,
        owner_id: str,
    ) -> dict[str, BackendJobDefinition]:
        definitions = self._definitions.get(owner_id)
        if definitions is None:
            raise BackendJobNotFoundError(
                f"backend job owner '{owner_id}' is not active"
            )
        return definitions

    def _get_job(self, owner_id: str, job_id: str) -> _BackendJobRecord:
        record = self._jobs.get(job_id)
        if record is None or record.identity.owner_id != owner_id:
            raise BackendJobNotFoundError(f"backend job '{job_id}' was not found")
        return record

    def _evict_locked(self) -> None:
        now = float(self._now())
        removable = [
            record
            for record in self._jobs.values()
            if record.status in ("succeeded", "failed", "cancelled")
            and now - record.updated_at > self._finished_ttl_seconds
        ]
        for record in removable:
            self._jobs.pop(record.identity.job_id, None)
            self._tasks.pop(record.identity.job_id, None)
            self._artifacts.remove_job(
                record.identity.owner_id,
                record.identity.job_id,
            )
        self._artifacts.remove_unclaimed_older_than(
            now - self._unclaimed_artifact_ttl_seconds
        )

    def _evict_finished_for_capacity_locked(self, owner_id: str) -> None:
        retained = sum(
            1
            for record in self._jobs.values()
            if record.identity.owner_id == owner_id
        )
        needed = retained - self._max_jobs_per_owner + 1
        if needed <= 0:
            return
        finished = sorted(
            (
                record
                for record in self._jobs.values()
                if record.identity.owner_id == owner_id
                and record.status in ("succeeded", "failed", "cancelled")
            ),
            key=lambda record: record.updated_at,
        )
        for record in finished[:needed]:
            self._jobs.pop(record.identity.job_id, None)
            self._tasks.pop(record.identity.job_id, None)
            self._artifacts.remove_job(owner_id, record.identity.job_id)

    def _finish_cancelled_locked(self, record: _BackendJobRecord) -> None:
        record.status = "cancelled"
        record.progress = 1.0
        record.message = "Cancelled"
        record.updated_at = float(self._now())

    @staticmethod
    def _validate_definition(definition: BackendJobDefinition) -> None:
        if not isinstance(definition, BackendJobDefinition):
            raise BackendJobValidationError(
                "backend jobs must be BackendJobDefinition instances"
            )
        if not _CONTRIBUTION_ID_PATTERN.fullmatch(definition.id):
            raise BackendJobValidationError(
                f"invalid backend job type ID '{definition.id}'"
            )
        if not definition.label.strip() or len(definition.label.strip()) > 120:
            raise BackendJobValidationError(
                f"backend job '{definition.id}' label must contain 1-120 characters"
            )
        if not callable(definition.run):
            raise BackendJobValidationError(
                f"backend job '{definition.id}' run must be callable"
            )
        if (
            not math.isfinite(definition.timeout_seconds)
            or definition.timeout_seconds <= 0
        ):
            raise BackendJobValidationError(
                f"backend job '{definition.id}' timeout_seconds must be "
                "positive and finite"
            )
        for name, callback in (
            ("validate_input", definition.validate_input),
            ("validate_result", definition.validate_result),
            ("readiness", definition.readiness),
        ):
            if callback is not None and not callable(callback):
                raise BackendJobValidationError(
                    f"backend job '{definition.id}' {name} must be callable"
                )
