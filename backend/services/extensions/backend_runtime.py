"""Startup-only activation for approved, staged backend extensions."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import inspect
import logging
import math
import sys
import threading
from dataclasses import dataclass
from importlib.machinery import ModuleSpec
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Awaitable, Callable, Literal

from fastapi import APIRouter, FastAPI

from services.extensions.backend_artifacts import (
    BackendArtifactError,
    BackendArtifactStore,
    StagedBackendArtifacts,
)
from services.extensions.manager import (
    ExtensionInventoryItem,
    ExtensionManager,
)
from services.extensions.job_artifacts import ExtensionJobArtifactStore
from services.extensions.jobs import BackendJobDefinition, BackendJobManager
from services.extensions.manifest import (
    EXTENSION_SDK_VERSION,
    is_extension_sdk_compatible,
    is_stable_semver_range_compatible,
)
from services.extensions.host_version import VLO_APPLICATION_VERSION

DEFAULT_BACKEND_EXTENSION_ACTIVATION_TIMEOUT_SECONDS = 10.0

BackendActivationStatus = Literal["active", "failed"]
BackendRuntimeStatus = Literal[
    "not_declared",
    "inactive",
    "restart_required",
    "active",
    "failed",
]
BackendShutdown = Callable[[], object | Awaitable[object]]


@dataclass(frozen=True)
class BackendExtensionIdentity:
    id: str
    version: str


@dataclass(frozen=True)
class BackendExtensionContext:
    extension: BackendExtensionIdentity
    sdk_version: str
    package_dir: Path
    logger: logging.LoggerAdapter[logging.Logger]
    raw_api_prefix: str


@dataclass(frozen=True)
class BackendExtensionDefinition:
    router: APIRouter | None = None
    jobs: tuple[BackendJobDefinition, ...] = ()
    shutdown: BackendShutdown | None = None


@dataclass(frozen=True)
class BackendExtensionActivationRecord:
    extension_id: str
    digest: str
    status: BackendActivationStatus
    message: str


@dataclass(frozen=True)
class BackendExtensionRuntimeView:
    status: BackendRuntimeStatus
    message: str
    digest: str | None = None


@dataclass(frozen=True)
class BackendExtensionStartSummary:
    records: tuple[BackendExtensionActivationRecord, ...]
    inventory_error: str | None = None


@dataclass
class _ActiveBackendSession:
    extension_id: str
    digest: str
    shutdown: BackendShutdown | None
    module_prefix: str


@dataclass(frozen=True)
class _FactoryCallResult:
    value: object
    module_prefix: str


class BackendExtensionActivationError(RuntimeError):
    """Raised for one extension activation without stopping core startup."""


class BackendExtensionActivationTimeoutError(BackendExtensionActivationError):
    """Raised when one backend activation exceeds the host startup budget."""


def _module_prefix(extension_id: str, digest: str) -> str:
    identity_hash = hashlib.sha256(
        f"{extension_id}\0{digest}".encode("utf-8")
    ).hexdigest()
    return f"_vlo_extension_{identity_hash}"


def _remove_modules(prefix: str) -> None:
    for module_name in tuple(sys.modules):
        if module_name == prefix or module_name.startswith(f"{prefix}."):
            sys.modules.pop(module_name, None)


def _create_namespace_package(prefix: str, package_dir: Path) -> None:
    module = ModuleType(prefix)
    spec = ModuleSpec(prefix, loader=None, is_package=True)
    spec.submodule_search_locations = [str(package_dir)]
    module.__spec__ = spec
    module.__package__ = prefix
    module.__path__ = [str(package_dir)]  # type: ignore[attr-defined]
    sys.modules[prefix] = module


def _load_factory(
    staged: StagedBackendArtifacts,
) -> tuple[Callable[[BackendExtensionContext], object], str]:
    module_name, factory_name = staged.entry.split(":", 1)
    prefix = _module_prefix(staged.extension_id, staged.digest)
    _remove_modules(prefix)
    _create_namespace_package(prefix, staged.package_dir)
    importlib.invalidate_caches()

    try:
        module = importlib.import_module(f"{prefix}.{module_name}")
    except Exception:
        _remove_modules(prefix)
        raise

    factory = getattr(module, factory_name, None)
    if not callable(factory):
        _remove_modules(prefix)
        raise BackendExtensionActivationError(
            f"backend entry factory '{factory_name}' is missing or not callable"
        )
    return factory, prefix


def _discard_factory_result(result: _FactoryCallResult) -> None:
    if inspect.iscoroutine(result.value):
        result.value.close()
    _remove_modules(result.module_prefix)


async def _call_factory_without_blocking_startup(
    staged: StagedBackendArtifacts,
    context: BackendExtensionContext,
    timeout_seconds: float,
) -> _FactoryCallResult:
    """Run synchronous import/factory work in an abandonable daemon thread.

    Python cannot safely terminate in-process code. On timeout the host stops
    waiting and starts serving, while the worker is marked for cleanup if it ever
    returns. Trusted extension side effects already performed cannot be rolled back.
    """

    abandoned = threading.Event()
    completed = threading.Event()
    state_lock = threading.Lock()
    results: list[_FactoryCallResult] = []
    errors: list[Exception] = []

    def worker() -> None:
        module_prefix: str | None = None
        try:
            factory, module_prefix = _load_factory(staged)
            result = _FactoryCallResult(
                value=factory(context),
                module_prefix=module_prefix,
            )
        except BaseException as exc:
            if module_prefix is not None:
                _remove_modules(module_prefix)
            with state_lock:
                if abandoned.is_set():
                    return
                errors.append(
                    exc
                    if isinstance(exc, Exception)
                    else BackendExtensionActivationError(
                        f"backend factory terminated with {type(exc).__name__}"
                    )
                )
                completed.set()
            return

        with state_lock:
            should_discard = abandoned.is_set()
            if not should_discard:
                results.append(result)
                completed.set()
        if should_discard:
            _discard_factory_result(result)

    thread = threading.Thread(
        target=worker,
        name=f"vlo-extension-activate-{staged.extension_id}",
        daemon=True,
    )
    thread.start()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    try:
        while not completed.is_set():
            remaining = deadline - loop.time()
            if remaining <= 0:
                with state_lock:
                    if completed.is_set():
                        break
                    abandoned.set()
                raise BackendExtensionActivationTimeoutError(
                    f"backend activation exceeded {timeout_seconds:g} seconds; "
                    "in-process work cannot be forcibly terminated"
                )
            await asyncio.sleep(min(0.01, remaining))
    except asyncio.CancelledError:
        with state_lock:
            abandoned.set()
            abandoned_results = tuple(results)
            results.clear()
        for result in abandoned_results:
            _discard_factory_result(result)
        raise

    if errors:
        raise errors[0]
    assert len(results) == 1
    return results[0]


def _normalize_definition(value: object) -> BackendExtensionDefinition:
    if value is None:
        return BackendExtensionDefinition()
    if isinstance(value, APIRouter):
        return BackendExtensionDefinition(router=value)
    if isinstance(value, BackendExtensionDefinition):
        return value
    raise BackendExtensionActivationError(
        "backend factory must return BackendExtensionDefinition, APIRouter, or None"
    )


def _route_keys(path: str, methods: set[str] | None) -> set[tuple[str, str]]:
    if methods:
        return {(path, method.upper()) for method in methods}
    return {(path, "WEBSOCKET")}


def _validate_route_path(path: str) -> None:
    if not path.startswith("/") or "//" in path:
        raise BackendExtensionActivationError(
            f"extension route path must be normalized and absolute: {path}"
        )
    if any(part in {".", ".."} for part in PurePosixPath(path).parts):
        raise BackendExtensionActivationError(
            f"extension route path cannot contain traversal segments: {path}"
        )


def _validate_router(app: FastAPI, router: APIRouter, prefix: str) -> None:
    existing_keys: set[tuple[str, str]] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        if not isinstance(path, str):
            continue
        methods = getattr(route, "methods", None)
        existing_keys.update(_route_keys(path, methods))

    extension_keys: set[tuple[str, str]] = set()
    for route in router.routes:
        path = getattr(route, "path", None)
        if not isinstance(path, str):
            raise BackendExtensionActivationError(
                "extension router contains an unsupported route type"
            )
        _validate_route_path(path)
        methods = getattr(route, "methods", None)
        keys = _route_keys(f"{prefix}{path}", methods)
        duplicate_keys = extension_keys.intersection(keys)
        if duplicate_keys:
            duplicate_path, duplicate_method = sorted(duplicate_keys)[0]
            raise BackendExtensionActivationError(
                f"duplicate extension route: {duplicate_method} {duplicate_path}"
            )
        collision_keys = existing_keys.intersection(keys)
        if collision_keys:
            collision_path, collision_method = sorted(collision_keys)[0]
            raise BackendExtensionActivationError(
                f"extension route collides with host route: "
                f"{collision_method} {collision_path}"
            )
        extension_keys.update(keys)


def _include_router_before_frontend_fallback(
    app: FastAPI,
    router: APIRouter,
    prefix: str,
) -> None:
    previous_route_count = len(app.router.routes)
    try:
        app.include_router(router, prefix=prefix)
    except Exception:
        del app.router.routes[previous_route_count:]
        raise
    extension_routes = app.router.routes[previous_route_count:]
    if not extension_routes:
        return

    del app.router.routes[previous_route_count:]
    fallback_index = next(
        (
            index
            for index, route in enumerate(app.router.routes)
            if getattr(route, "path", None) == "/{full_path:path}"
        ),
        len(app.router.routes),
    )
    app.router.routes[fallback_index:fallback_index] = extension_routes


async def _call_shutdown(shutdown: BackendShutdown | None) -> None:
    if shutdown is None:
        return
    result = shutdown()
    if inspect.isawaitable(result):
        await result


class BackendExtensionRuntime:
    def __init__(
        self,
        manager: ExtensionManager,
        artifacts: BackendArtifactStore,
        *,
        activation_timeout_seconds: float = (
            DEFAULT_BACKEND_EXTENSION_ACTIVATION_TIMEOUT_SECONDS
        ),
        job_artifacts: ExtensionJobArtifactStore | None = None,
    ) -> None:
        if (
            not math.isfinite(activation_timeout_seconds)
            or activation_timeout_seconds <= 0
        ):
            raise ValueError("activation_timeout_seconds must be positive and finite")
        self._manager = manager
        self._artifacts = artifacts
        self._job_artifacts = job_artifacts or ExtensionJobArtifactStore(
            artifacts.root.parent / "job-artifacts"
        )
        self._jobs = BackendJobManager(self._job_artifacts)
        self._activation_timeout_seconds = activation_timeout_seconds
        self._start_lock = asyncio.Lock()
        self._started = False
        self._summary = BackendExtensionStartSummary(records=())
        self._records: dict[str, BackendExtensionActivationRecord] = {}
        self._sessions: list[_ActiveBackendSession] = []

    @property
    def artifacts(self) -> BackendArtifactStore:
        return self._artifacts

    @property
    def jobs(self) -> BackendJobManager:
        return self._jobs

    def active_digest(self, extension_id: str) -> str | None:
        return next(
            (
                session.digest
                for session in reversed(self._sessions)
                if session.extension_id == extension_id
            ),
            None,
        )

    async def start(self, app: FastAPI) -> BackendExtensionStartSummary:
        async with self._start_lock:
            if self._started:
                return self._summary
            self._started = True

            try:
                inventory = self._manager.scan(force_digest=True)
            except Exception as exc:
                self._summary = BackendExtensionStartSummary(
                    records=(),
                    inventory_error=str(exc),
                )
                logging.getLogger(__name__).exception(
                    "Backend extension inventory failed during startup"
                )
                return self._summary

            records: list[BackendExtensionActivationRecord] = []
            for item in inventory:
                if (
                    item.status != "approved"
                    or item.manifest is None
                    or item.manifest.backend is None
                    or item.digest is None
                ):
                    continue
                record = await self._activate_item(app, item)
                self._records[item.extension_id] = record
                records.append(record)

            self._summary = BackendExtensionStartSummary(records=tuple(records))
            return self._summary

    async def stop(self) -> tuple[str, ...]:
        errors: list[str] = []
        sessions = tuple(self._sessions)
        for session in reversed(sessions):
            try:
                await self._jobs.shutdown_extension(session.extension_id)
            except Exception as exc:
                errors.append(f"{session.extension_id} job cleanup: {exc}")
                logging.getLogger(__name__).exception(
                    "Backend extension job cleanup failed: %s",
                    session.extension_id,
                )
            try:
                await _call_shutdown(session.shutdown)
            except Exception as exc:
                errors.append(f"{session.extension_id}: {exc}")
                logging.getLogger(__name__).exception(
                    "Backend extension shutdown failed: %s",
                    session.extension_id,
                )
            finally:
                _remove_modules(session.module_prefix)
        self._sessions.clear()
        await self._jobs.shutdown_all()
        for extension_id in {session.extension_id for session in sessions}:
            try:
                self._prune_stopped_artifacts(extension_id)
            except Exception as exc:
                errors.append(f"{extension_id} artifact cleanup: {exc}")
                logging.getLogger(__name__).exception(
                    "Backend extension artifact cleanup failed: %s",
                    extension_id,
                )
        return tuple(errors)

    def _prune_stopped_artifacts(self, extension_id: str) -> None:
        try:
            item = self._manager.get_item(extension_id, force_digest=True)
        except Exception:
            self._artifacts.remove_extension(extension_id)
            return
        if item.status == "approved" and item.digest is not None:
            self._artifacts.prune_other_digests(extension_id, item.digest)
            return
        self._artifacts.remove_extension(extension_id)

    def describe(self, item: ExtensionInventoryItem) -> BackendExtensionRuntimeView:
        if item.manifest is None or item.manifest.backend is None:
            return BackendExtensionRuntimeView(
                status="not_declared",
                message="No backend entry point is declared.",
            )

        record = self._records.get(item.extension_id)
        if (
            record is not None
            and record.digest == item.digest
            and item.status == "approved"
        ):
            return BackendExtensionRuntimeView(
                status=record.status,
                message=record.message,
                digest=record.digest,
            )

        if record is not None and record.status == "active":
            return BackendExtensionRuntimeView(
                status="restart_required",
                message=(
                    "A previous approved backend digest remains active until restart."
                ),
                digest=record.digest,
            )
        if item.status == "approved":
            return BackendExtensionRuntimeView(
                status="restart_required",
                message="Approved backend code will activate after restart.",
                digest=item.digest,
            )
        return BackendExtensionRuntimeView(
            status="inactive",
            message="Backend extension is not approved for activation.",
            digest=item.digest,
        )

    async def _activate_item(
        self,
        app: FastAPI,
        item: ExtensionInventoryItem,
    ) -> BackendExtensionActivationRecord:
        assert item.manifest is not None
        assert item.manifest.backend is not None
        assert item.digest is not None
        extension_id = item.extension_id
        digest = item.digest
        prefix = f"/app/extensions/{extension_id}/api"
        definition: BackendExtensionDefinition | None = None
        module_prefix: str | None = None

        try:
            if not is_extension_sdk_compatible(item.manifest.sdk):
                raise BackendExtensionActivationError(
                    f"extension SDK range does not include host SDK "
                    f"{EXTENSION_SDK_VERSION}"
                )
            if item.manifest.vlo is not None:
                if VLO_APPLICATION_VERSION is None:
                    logging.getLogger("vlo.extensions").warning(
                        "Extension '%s' declares VLO range '%s', but the host "
                        "application version is unknown; compatibility was not verified.",
                        extension_id,
                        item.manifest.vlo,
                    )
                elif not is_stable_semver_range_compatible(
                    item.manifest.vlo,
                    VLO_APPLICATION_VERSION,
                ):
                    raise BackendExtensionActivationError(
                        f"extension VLO range does not include host application "
                        f"{VLO_APPLICATION_VERSION}"
                    )
            staged = self._artifacts.stage(item, digest)
            if staged is None:
                raise BackendArtifactError("backend staging produced no artifact")
            staged = self._artifacts.verify(
                extension_id,
                digest,
                item.manifest.backend.entry,
            )
            # Verification and Python import are separate reads. The staging tree
            # is host-owned, but this is integrity hardening rather than an atomic
            # execution or sandbox boundary for trusted in-process code.
            logger = logging.LoggerAdapter(
                logging.getLogger(f"vlo.extensions.{extension_id}"),
                {"extension_id": extension_id},
            )
            context = BackendExtensionContext(
                extension=BackendExtensionIdentity(
                    id=extension_id,
                    version=item.manifest.version,
                ),
                sdk_version=EXTENSION_SDK_VERSION,
                package_dir=staged.package_dir,
                logger=logger,
                raw_api_prefix=prefix,
            )
            activation_started = asyncio.get_running_loop().time()
            factory_call = await _call_factory_without_blocking_startup(
                staged,
                context,
                self._activation_timeout_seconds,
            )
            module_prefix = factory_call.module_prefix
            factory_result = factory_call.value
            if inspect.isawaitable(factory_result):
                elapsed = asyncio.get_running_loop().time() - activation_started
                remaining = self._activation_timeout_seconds - elapsed
                if remaining <= 0:
                    if inspect.iscoroutine(factory_result):
                        factory_result.close()
                    raise BackendExtensionActivationTimeoutError(
                        "backend activation exceeded "
                        f"{self._activation_timeout_seconds:g} seconds"
                    )
                try:
                    factory_result = await asyncio.wait_for(
                        factory_result,
                        timeout=remaining,
                    )
                except TimeoutError as exc:
                    raise BackendExtensionActivationTimeoutError(
                        "backend activation exceeded "
                        f"{self._activation_timeout_seconds:g} seconds"
                    ) from exc
            definition = _normalize_definition(factory_result)
            self._jobs.register_extension(
                extension_id,
                item.manifest.version,
                definition.jobs,
            )
            if definition.router is not None:
                _validate_router(app, definition.router, prefix)
                _include_router_before_frontend_fallback(
                    app,
                    definition.router,
                    prefix,
                )

            self._sessions.append(
                _ActiveBackendSession(
                    extension_id=extension_id,
                    digest=digest,
                    shutdown=definition.shutdown,
                    module_prefix=module_prefix,
                )
            )
            return BackendExtensionActivationRecord(
                extension_id=extension_id,
                digest=digest,
                status="active",
                message="Backend extension is active.",
            )
        except Exception as exc:
            self._jobs.unregister_extension(extension_id)
            try:
                if definition is not None:
                    await _call_shutdown(definition.shutdown)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Backend extension rollback failed: %s",
                    extension_id,
                )
            if module_prefix is not None:
                _remove_modules(module_prefix)
            logging.getLogger(__name__).exception(
                "Backend extension activation failed: %s",
                extension_id,
            )
            return BackendExtensionActivationRecord(
                extension_id=extension_id,
                digest=digest,
                status="failed",
                message=f"Backend activation failed: {exc}",
            )
