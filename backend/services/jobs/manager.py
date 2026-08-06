"""Owner-neutral lifecycle for trusted host and extension backend jobs."""

from __future__ import annotations

import asyncio
from concurrent.futures import Executor, ThreadPoolExecutor
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
        self._now = now
        self._lock = threading.RLock()
        self._definitions: dict[str, dict[str, BackendJobDefinition]] = {}
        self._owner_versions: dict[str, str] = {}
        self._jobs: dict[str, _BackendJobRecord] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._max_concurrent_jobs_per_owner = max_concurrent_jobs_per_owner
        self._evict_finished_jobs_at_capacity = evict_finished_jobs_at_capacity
        self._owner_semaphores: dict[str, asyncio.Semaphore] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=executor_max_workers,
            thread_name_prefix=thread_name_prefix,
        )
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
        self._executor.shutdown(wait=False, cancel_futures=True)

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
                record.status = "failed"
                record.progress = 1.0
                record.message = "Timed out"
                record.error = (
                    f"job exceeded its {record.definition.timeout_seconds:g} "
                    "second timeout"
                )
                record.updated_at = float(self._now())
        except (asyncio.CancelledError, BackendJobCancelledError):
            with self._lock:
                self._finish_cancelled_locked(record)
        except Exception as exc:
            with self._lock:
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

    async def _invoke_runner(
        self,
        record: _BackendJobRecord,
        context: BackendJobContext,
    ) -> object:
        """Start the timeout and running state when a worker actually begins."""

        loop = asyncio.get_running_loop()
        started = asyncio.Event()

        def invoke() -> object:
            try:
                self._mark_running(record.identity.job_id)
            finally:
                loop.call_soon_threadsafe(started.set)
            return record.definition.run(
                context,
                _clone_json(record.input_value),
            )

        concurrent_future = self._executor.submit(invoke)
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
            concurrent_future.cancel()
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
