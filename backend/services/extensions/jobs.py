"""Host-owned lifecycle for trusted backend extension jobs."""

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

from services.extensions.job_artifacts import (
    ExtensionJobArtifactRecord,
    ExtensionJobArtifactStore,
)


DEFAULT_FINISHED_JOB_TTL_SECONDS = 15 * 60
DEFAULT_UNCLAIMED_ARTIFACT_TTL_SECONDS = 15 * 60
DEFAULT_MAX_JOBS_PER_EXTENSION = 64
DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_EXTENSION = 32
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
    """Base error for the standard backend extension job surface."""


class BackendJobNotFoundError(BackendJobError):
    """Raised for unknown job types or instances."""


class BackendJobValidationError(BackendJobError):
    """Raised when extension input/result validation fails."""


class BackendJobNotReadyError(BackendJobError):
    """Raised when a declared model/service dependency is not ready."""


class BackendJobCapacityError(BackendJobError):
    """Raised when an extension has too many retained/running jobs."""


class BackendJobCancelledError(BackendJobError):
    """Cooperative cancellation signal available to extension handlers."""


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
    extension_id: str
    extension_version: str
    job_id: str
    job_type: str


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
    artifacts: tuple[ExtensionJobArtifactRecord, ...]
    diagnostics: tuple[BackendJobDiagnostic, ...]

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "jobId": self.identity.job_id,
            "jobType": self.identity.job_type,
            "extensionId": self.identity.extension_id,
            "extensionVersion": self.identity.extension_version,
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


class BackendJobArtifactAccess:
    def __init__(
        self,
        store: ExtensionJobArtifactStore,
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
            self._identity.extension_id,
            self._identity.job_id,
            artifact_id,
        )

    def create(
        self,
        content: bytes,
        *,
        filename: str,
        content_type: str = "application/octet-stream",
    ) -> ExtensionJobArtifactRecord:
        if self._cancel_event.is_set():
            raise BackendJobCancelledError("job cancellation was requested")
        return self._store.create_output(
            self._identity.extension_id,
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
    ) -> None:
        self.identity = identity
        self.artifacts = artifacts
        self._cancel_event = cancel_event
        self._report_progress = report_progress
        self._report_diagnostic = report_diagnostic

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


class BackendJobManager:
    def __init__(
        self,
        artifacts: ExtensionJobArtifactStore,
        *,
        finished_ttl_seconds: float = DEFAULT_FINISHED_JOB_TTL_SECONDS,
        unclaimed_artifact_ttl_seconds: float = (
            DEFAULT_UNCLAIMED_ARTIFACT_TTL_SECONDS
        ),
        max_jobs_per_extension: int = DEFAULT_MAX_JOBS_PER_EXTENSION,
        max_unclaimed_artifacts_per_extension: int = (
            DEFAULT_MAX_UNCLAIMED_ARTIFACTS_PER_EXTENSION
        ),
        validation_timeout_seconds: float = (
            DEFAULT_JOB_VALIDATION_TIMEOUT_SECONDS
        ),
        now: Callable[[], float] = time.time,
    ) -> None:
        if finished_ttl_seconds <= 0 or unclaimed_artifact_ttl_seconds <= 0:
            raise ValueError("job TTLs must be positive")
        if max_jobs_per_extension <= 0:
            raise ValueError("max_jobs_per_extension must be positive")
        if max_unclaimed_artifacts_per_extension <= 0:
            raise ValueError(
                "max_unclaimed_artifacts_per_extension must be positive"
            )
        if validation_timeout_seconds <= 0:
            raise ValueError("validation_timeout_seconds must be positive")
        self._artifacts = artifacts
        self._finished_ttl_seconds = finished_ttl_seconds
        self._unclaimed_artifact_ttl_seconds = unclaimed_artifact_ttl_seconds
        self._max_jobs_per_extension = max_jobs_per_extension
        self._max_unclaimed_artifacts_per_extension = (
            max_unclaimed_artifacts_per_extension
        )
        self._validation_timeout_seconds = validation_timeout_seconds
        self._now = now
        self._lock = threading.RLock()
        self._definitions: dict[str, dict[str, BackendJobDefinition]] = {}
        self._extension_versions: dict[str, str] = {}
        self._jobs: dict[str, _BackendJobRecord] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="vlo-extension-job",
        )
        self._closed = False

    @property
    def artifacts(self) -> ExtensionJobArtifactStore:
        return self._artifacts

    def register_extension(
        self,
        extension_id: str,
        extension_version: str,
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
            if extension_id in self._definitions:
                raise BackendJobValidationError(
                    f"backend jobs for '{extension_id}' are already registered"
                )
            self._definitions[extension_id] = validated
            self._extension_versions[extension_id] = extension_version

    def unregister_extension(self, extension_id: str) -> None:
        with self._lock:
            self._definitions.pop(extension_id, None)
            self._extension_versions.pop(extension_id, None)

    def is_registered(self, extension_id: str) -> bool:
        with self._lock:
            return extension_id in self._definitions

    async def list_job_types(self, extension_id: str) -> tuple[dict[str, object], ...]:
        with self._lock:
            definitions = tuple(self._get_definitions(extension_id).values())
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
        extension_id: str,
        content: bytes,
        *,
        filename: str,
        content_type: str,
    ) -> ExtensionJobArtifactRecord:
        with self._lock:
            definitions = self._get_definitions(extension_id)
            if not definitions:
                raise BackendJobNotFoundError(
                    f"backend extension '{extension_id}' has no standard jobs"
                )
            self._evict_locked()
            if (
                self._artifacts.count_unclaimed(extension_id)
                >= self._max_unclaimed_artifacts_per_extension
            ):
                raise BackendJobCapacityError(
                    f"extension '{extension_id}' has reached its unclaimed artifact limit"
                )
            return self._artifacts.create_input(
                extension_id,
                content,
                filename=filename,
                content_type=content_type,
            )

    async def submit(
        self,
        extension_id: str,
        job_type: str,
        input_value: object,
        input_artifact_ids: tuple[str, ...] = (),
    ) -> BackendJobSnapshot:
        with self._lock:
            definitions = self._get_definitions(extension_id)
            definition = definitions.get(job_type)
            extension_version = self._extension_versions[extension_id]
        if definition is None:
            raise BackendJobNotFoundError(
                f"backend job type '{extension_id}/{job_type}' was not found"
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
            extension_id=extension_id,
            extension_version=extension_version,
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
            self._get_definitions(extension_id)
            self._evict_locked()
            retained = sum(
                1
                for candidate in self._jobs.values()
                if candidate.identity.extension_id == extension_id
            )
            if retained >= self._max_jobs_per_extension:
                raise BackendJobCapacityError(
                    f"extension '{extension_id}' has reached its job limit"
                )
            self._artifacts.claim_inputs(
                extension_id,
                job_id,
                tuple(input_artifact_ids),
            )
            self._jobs[job_id] = record
            task = asyncio.create_task(
                self._run_job(record),
                name=f"vlo-extension-job-{extension_id}-{job_id}",
            )
            self._tasks[job_id] = task
            return self._snapshot_locked(record)

    def get(self, extension_id: str, job_id: str) -> BackendJobSnapshot:
        with self._lock:
            self._evict_locked()
            return self._snapshot_locked(self._get_job(extension_id, job_id))

    async def cancel(self, extension_id: str, job_id: str) -> BackendJobSnapshot:
        task: asyncio.Task[None] | None
        with self._lock:
            record = self._get_job(extension_id, job_id)
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
            record = self._get_job(extension_id, job_id)
            if record.status not in ("succeeded", "failed", "cancelled"):
                self._finish_cancelled_locked(record)
            self._tasks.pop(job_id, None)
            return self._snapshot_locked(record)

    def get_artifact(
        self,
        extension_id: str,
        artifact_id: str,
    ) -> tuple[ExtensionJobArtifactRecord, bytes]:
        with self._lock:
            self._get_definitions(extension_id)
        return self._artifacts.get_for_delivery(extension_id, artifact_id)

    async def shutdown_extension(self, extension_id: str) -> None:
        with self._lock:
            self.unregister_extension(extension_id)
            records = [
                record
                for record in self._jobs.values()
                if record.identity.extension_id == extension_id
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
        self._artifacts.remove_extension(extension_id)

    async def shutdown_all(self) -> None:
        with self._lock:
            extension_ids = tuple(self._definitions)
        for extension_id in reversed(extension_ids):
            await self.shutdown_extension(extension_id)
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)

    async def _run_job(self, record: _BackendJobRecord) -> None:
        identity = record.identity
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
        )
        with self._lock:
            if record.cancel_event.is_set():
                self._finish_cancelled_locked(record)
                return
            record.status = "running"
            record.message = "Running"
            record.updated_at = float(self._now())
        try:
            result = await _invoke_callback(
                record.definition.run,
                context,
                _clone_json(record.input_value),
                timeout=record.definition.timeout_seconds,
                offload_sync=True,
                executor=self._executor,
            )
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
            with self._lock:
                self._tasks.pop(identity.job_id, None)

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
            record.identity.extension_id,
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
        )

    def _get_definitions(
        self,
        extension_id: str,
    ) -> dict[str, BackendJobDefinition]:
        definitions = self._definitions.get(extension_id)
        if definitions is None:
            raise BackendJobNotFoundError(
                f"backend extension '{extension_id}' is not active"
            )
        return definitions

    def _get_job(self, extension_id: str, job_id: str) -> _BackendJobRecord:
        record = self._jobs.get(job_id)
        if record is None or record.identity.extension_id != extension_id:
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
                record.identity.extension_id,
                record.identity.job_id,
            )
        self._artifacts.remove_unclaimed_older_than(
            now - self._unclaimed_artifact_ttl_seconds
        )

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
                f"backend job '{definition.id}' timeout_seconds must be positive and finite"
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
