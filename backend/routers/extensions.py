"""Management API for inert discovery and approved frontend artifacts."""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from api_errors import error_response
from config import EXTENSIONS_ROOT, EXTENSION_STATE_DIR
from services.extensions import (
    BackendArtifactError,
    BackendArtifactStore,
    BackendExtensionRuntime,
    BackendJobCapacityError,
    BackendJobError,
    BackendJobNotFoundError,
    BackendJobNotReadyError,
    BackendJobValidationError,
    ExtensionApprovalStateError,
    ExtensionApprovalStore,
    ExtensionInventoryError,
    ExtensionInventoryItem,
    ExtensionManager,
    FrontendArtifactError,
    FrontendArtifactStore,
    ExtensionJobArtifactError,
    ExtensionJobArtifactNotFoundError,
    ExtensionJobArtifactTooLargeError,
    check_python_dependencies,
)
from services.extensions.frontend_artifacts import staged_package_resource_path

router = APIRouter(prefix="/app/extensions", tags=["extensions"])


class ExtensionApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class BackendJobSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: object = None
    artifacts: list[str] = Field(default_factory=list, max_length=32)


@dataclass(frozen=True)
class ExtensionServices:
    manager: ExtensionManager
    artifacts: FrontendArtifactStore
    backend_artifacts: BackendArtifactStore
    backend_runtime: BackendExtensionRuntime


_extension_manager = ExtensionManager(
    EXTENSIONS_ROOT,
    ExtensionApprovalStore(EXTENSION_STATE_DIR / "approvals.json"),
)
_backend_artifacts = BackendArtifactStore(
    EXTENSION_STATE_DIR / "backend-artifacts",
    EXTENSIONS_ROOT,
)
_extension_services = ExtensionServices(
    manager=_extension_manager,
    artifacts=FrontendArtifactStore(
        EXTENSION_STATE_DIR / "frontend-artifacts",
        EXTENSIONS_ROOT,
    ),
    backend_artifacts=_backend_artifacts,
    backend_runtime=BackendExtensionRuntime(
        _extension_manager,
        _backend_artifacts,
    ),
)


def get_extension_services() -> ExtensionServices:
    return _extension_services


ExtensionServicesDependency = Annotated[
    ExtensionServices,
    Depends(get_extension_services),
]


def _frontend_entry_path(item: ExtensionInventoryItem) -> str | None:
    manifest = item.manifest
    if manifest is None or manifest.frontend is None:
        return None
    entry = PurePosixPath(manifest.frontend.entry)
    return entry.relative_to(entry.parent).as_posix()


def _frontend_entry_url(
    item: ExtensionInventoryItem,
    artifacts: FrontendArtifactStore,
) -> str | None:
    if item.status != "approved" or item.digest is None:
        return None
    entry_path = _frontend_entry_path(item)
    if entry_path is None or not artifacts.has(item.extension_id, item.digest):
        return None
    return (
        f"/app/extensions/{quote(item.extension_id, safe='')}/frontend/"
        f"{quote(item.digest, safe='')}/{quote(entry_path, safe='/')}"
    )


def _lut_contribution_resources(
    item: ExtensionInventoryItem,
    artifacts: FrontendArtifactStore,
) -> list[dict[str, object]]:
    if item.status != "approved" or item.digest is None:
        return []

    resources: list[dict[str, object]] = []
    for contribution in item.lut_contributions:
        artifact_path = staged_package_resource_path(contribution.path)
        if not artifacts.has_path(item.extension_id, item.digest, artifact_path):
            continue
        resource_url = (
            f"/app/extensions/{quote(item.extension_id, safe='')}/resources/"
            f"{quote(item.digest, safe='')}/{quote(contribution.path, safe='/')}"
        )
        resources.append(
            {
                "id": contribution.id,
                "label": contribution.label,
                "description": contribution.description,
                "order": contribution.order,
                "resourceUrl": resource_url,
            }
        )
    return resources


def _preflight_report(item: ExtensionInventoryItem) -> dict[str, object] | None:
    """Report declared Python dependency readiness as an inert checklist.

    Returns ``None`` when no dependencies are declared so the UI can omit the
    section entirely. This never installs or imports extension code.
    """

    if item.manifest is None or not item.manifest.python_dependencies:
        return None
    report = check_python_dependencies(item.manifest.python_dependencies)
    return {
        "satisfied": report.satisfied,
        "dependencies": [
            {
                "module": status.module,
                "distribution": status.distribution,
                "purpose": status.purpose,
                "satisfied": status.satisfied,
                "detail": status.detail,
            }
            for status in report.dependencies
        ],
        "installHints": list(report.install_hints),
        "environment": report.environment,
        "isolated": report.isolated,
    }


def _serialize_inventory_item(
    item: ExtensionInventoryItem,
    artifacts: FrontendArtifactStore,
    backend_runtime: BackendExtensionRuntime,
) -> dict[str, object]:
    manifest = (
        item.manifest.model_dump(by_alias=True, mode="json", exclude_none=True)
        if item.manifest is not None
        else None
    )
    approval = (
        {
            "digest": item.approval.digest,
            "version": item.approval.version,
            "approvedAt": item.approval.approved_at,
            "enabled": item.approval.enabled,
        }
        if item.approval is not None
        else None
    )
    backend_runtime_view = backend_runtime.describe(item)
    return {
        "id": item.extension_id,
        "sourcePath": str(item.package_dir.resolve()),
        "status": item.status,
        "digest": item.digest,
        "errors": list(item.errors),
        "manifest": manifest,
        "approval": approval,
        "frontendEntryUrl": _frontend_entry_url(item, artifacts),
        "lutContributions": _lut_contribution_resources(item, artifacts),
        "backendRuntime": {
            "status": backend_runtime_view.status,
            "message": backend_runtime_view.message,
            "digest": backend_runtime_view.digest,
        },
        "preflight": _preflight_report(item),
    }


def _inventory_error_response(error: Exception) -> JSONResponse:
    return error_response(
        500,
        "extension_inventory_unavailable",
        "Extension inventory is unavailable.",
        retryable=True,
        details={"reason": str(error)},
    )


def _mutation_error_response(error: ExtensionInventoryError) -> JSONResponse:
    message = str(error)
    if message.endswith("was not found"):
        return error_response(
            404,
            "extension_not_found",
            message,
            retryable=False,
        )
    return error_response(
        409,
        "extension_state_conflict",
        message,
        retryable=True,
    )


def _backend_job_error_response(error: Exception) -> JSONResponse:
    if isinstance(error, (BackendJobNotFoundError, ExtensionJobArtifactNotFoundError)):
        return error_response(
            404,
            "extension_job_not_found",
            str(error),
            retryable=False,
        )
    if isinstance(error, BackendJobNotReadyError):
        return error_response(
            409,
            "extension_job_not_ready",
            str(error),
            retryable=True,
        )
    if isinstance(error, BackendJobCapacityError):
        return error_response(
            429,
            "extension_job_capacity",
            str(error),
            retryable=True,
        )
    if isinstance(error, ExtensionJobArtifactTooLargeError):
        return error_response(
            413,
            "extension_artifact_too_large",
            str(error),
            retryable=False,
        )
    if isinstance(error, (BackendJobValidationError, ExtensionJobArtifactError)):
        return error_response(
            400,
            "extension_job_invalid",
            str(error),
            retryable=False,
        )
    return error_response(
        500,
        "extension_job_failed",
        "The extension job request failed.",
        retryable=True,
        details={"reason": str(error)},
    )


@router.get("")
def list_extensions(services: ExtensionServicesDependency):
    try:
        items = services.manager.scan()
    except (ExtensionApprovalStateError, ExtensionInventoryError, OSError) as exc:
        return _inventory_error_response(exc)
    return {
        "extensions": [
            _serialize_inventory_item(
                item,
                services.artifacts,
                services.backend_runtime,
            )
            for item in items
        ]
    }


@router.get("/{extension_id}/jobs")
async def list_backend_job_types(
    extension_id: str,
    services: ExtensionServicesDependency,
):
    try:
        jobs = await services.backend_runtime.jobs.list_job_types(extension_id)
    except BackendJobError as exc:
        return _backend_job_error_response(exc)
    return {"jobs": list(jobs)}


@router.post("/{extension_id}/artifacts")
async def upload_backend_job_artifact(
    extension_id: str,
    request: Request,
    services: ExtensionServicesDependency,
    filename: str = Query(min_length=1, max_length=255),
    content_type: str = Query(
        default="application/octet-stream",
        alias="contentType",
        min_length=1,
        max_length=200,
    ),
):
    try:
        content_length = request.headers.get("content-length")
        if (
            content_length is not None
            and int(content_length)
            > services.backend_runtime.jobs.artifacts.max_artifact_bytes
        ):
            raise ExtensionJobArtifactTooLargeError(
                "artifact exceeds the configured byte limit"
            )
        content = await request.body()
        record = services.backend_runtime.jobs.upload_input(
            extension_id,
            content,
            filename=filename,
            content_type=content_type,
        )
    except (ValueError, BackendJobError, ExtensionJobArtifactError) as exc:
        return _backend_job_error_response(exc)
    return {"artifact": record.to_dict()}


@router.post("/{extension_id}/jobs/{job_type}")
async def submit_backend_job(
    extension_id: str,
    job_type: str,
    request: BackendJobSubmitRequest,
    services: ExtensionServicesDependency,
):
    try:
        snapshot = await services.backend_runtime.jobs.submit(
            extension_id,
            job_type,
            request.input,
            tuple(request.artifacts),
        )
    except (BackendJobError, ExtensionJobArtifactError) as exc:
        return _backend_job_error_response(exc)
    return {"job": snapshot.to_dict()}


@router.get("/{extension_id}/jobs/{job_id}")
async def get_backend_job(
    extension_id: str,
    job_id: str,
    services: ExtensionServicesDependency,
):
    try:
        snapshot = services.backend_runtime.jobs.get(extension_id, job_id)
    except BackendJobError as exc:
        return _backend_job_error_response(exc)
    return {"job": snapshot.to_dict()}


@router.post("/{extension_id}/jobs/{job_id}/cancel")
async def cancel_backend_job(
    extension_id: str,
    job_id: str,
    services: ExtensionServicesDependency,
):
    try:
        snapshot = await services.backend_runtime.jobs.cancel(extension_id, job_id)
    except BackendJobError as exc:
        return _backend_job_error_response(exc)
    return {"job": snapshot.to_dict()}


@router.get("/{extension_id}/artifacts/{artifact_id}")
async def get_backend_job_artifact(
    extension_id: str,
    artifact_id: str,
    services: ExtensionServicesDependency,
):
    try:
        record, content = services.backend_runtime.jobs.get_artifact(
            extension_id,
            artifact_id,
        )
        if record.role != "output":
            raise ExtensionJobArtifactNotFoundError("artifact was not found")
    except (BackendJobError, ExtensionJobArtifactError) as exc:
        return _backend_job_error_response(exc)
    encoded_filename = quote(record.filename, safe="")
    return Response(
        content=content,
        media_type=record.content_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            "X-Content-Type-Options": "nosniff",
            "ETag": f'"sha256:{record.sha256}"',
        },
    )


@router.post("/{extension_id}/approve")
def approve_extension(
    extension_id: str,
    request: ExtensionApprovalRequest,
    services: ExtensionServicesDependency,
):
    try:
        prepared = services.manager.prepare_approval(extension_id, request.digest)
        services.artifacts.stage(prepared, request.digest)
        services.backend_artifacts.stage(prepared, request.digest)
        services.manager.approve(extension_id, request.digest)
        services.artifacts.prune_other_digests(extension_id, request.digest)
        retained_backend_digests = {request.digest}
        active_backend_digest = services.backend_runtime.active_digest(extension_id)
        if active_backend_digest is not None:
            retained_backend_digests.add(active_backend_digest)
        services.backend_artifacts.prune_digests(
            extension_id,
            retained_backend_digests,
        )
        item = services.manager.get_item(extension_id)
    except ExtensionInventoryError as exc:
        return _mutation_error_response(exc)
    except (
        BackendArtifactError,
        ExtensionApprovalStateError,
        FrontendArtifactError,
        OSError,
    ) as exc:
        return error_response(
            500,
            "extension_approval_failed",
            "Extension approval could not be persisted.",
            retryable=True,
            details={"reason": str(exc)},
        )
    return {
        "extension": _serialize_inventory_item(
            item,
            services.artifacts,
            services.backend_runtime,
        )
    }


@router.post("/{extension_id}/disable")
def disable_extension(
    extension_id: str,
    services: ExtensionServicesDependency,
):
    try:
        if not services.manager.disable(extension_id):
            return error_response(
                404,
                "extension_not_found",
                f"extension '{extension_id}' has no approval to disable",
                retryable=False,
            )
        item = services.manager.get_item(extension_id)
    except ExtensionInventoryError as exc:
        return _mutation_error_response(exc)
    except (ExtensionApprovalStateError, OSError) as exc:
        return _inventory_error_response(exc)
    return {
        "extension": _serialize_inventory_item(
            item,
            services.artifacts,
            services.backend_runtime,
        )
    }


@router.delete("/{extension_id}/approval")
def revoke_extension_approval(
    extension_id: str,
    services: ExtensionServicesDependency,
):
    try:
        revoked = services.manager.revoke(extension_id)
        services.artifacts.remove_extension(extension_id)
        if services.backend_runtime.active_digest(extension_id) is None:
            services.backend_artifacts.remove_extension(extension_id)
        if not revoked:
            return error_response(
                404,
                "extension_not_found",
                f"extension '{extension_id}' has no approval to revoke",
                retryable=False,
            )
        item = services.manager.get_item(extension_id)
    except ExtensionInventoryError as exc:
        return _mutation_error_response(exc)
    except (
        BackendArtifactError,
        ExtensionApprovalStateError,
        FrontendArtifactError,
        OSError,
    ) as exc:
        return _inventory_error_response(exc)
    return {
        "extension": _serialize_inventory_item(
            item,
            services.artifacts,
            services.backend_runtime,
        )
    }


@router.get("/{extension_id}/frontend/{digest}/{artifact_path:path}")
def get_frontend_artifact(
    extension_id: str,
    digest: str,
    artifact_path: str,
    services: ExtensionServicesDependency,
):
    try:
        services.manager.require_approved_digest(extension_id, digest)
        content = services.artifacts.read(extension_id, digest, artifact_path)
    except (ExtensionInventoryError, FrontendArtifactError, OSError):
        return error_response(
            404,
            "extension_artifact_not_found",
            "Approved extension artifact was not found.",
            retryable=False,
        )

    suffix = PurePosixPath(artifact_path).suffix
    media_type = (
        "text/javascript"
        if suffix in {".js", ".mjs"}
        else mimetypes.guess_type(artifact_path)[0] or "application/octet-stream"
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{digest}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{extension_id}/resources/{digest}/{artifact_path:path}")
def get_extension_resource(
    extension_id: str,
    digest: str,
    artifact_path: str,
    services: ExtensionServicesDependency,
):
    try:
        services.manager.require_approved_digest(extension_id, digest)
        staged_path = staged_package_resource_path(artifact_path)
        content = services.artifacts.read(extension_id, digest, staged_path)
    except (ExtensionInventoryError, FrontendArtifactError, OSError, ValueError):
        return error_response(
            404,
            "extension_resource_not_found",
            "Approved extension resource was not found.",
            retryable=False,
        )

    return Response(
        content=content,
        media_type=(
            mimetypes.guess_type(artifact_path)[0] or "application/octet-stream"
        ),
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{digest}"',
            "X-Content-Type-Options": "nosniff",
        },
    )
