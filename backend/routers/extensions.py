"""Management API for inert discovery and approved frontend artifacts."""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from api_errors import error_response
from config import EXTENSIONS_ROOT, EXTENSION_STATE_DIR
from services.extensions import (
    ExtensionApprovalStateError,
    ExtensionApprovalStore,
    ExtensionInventoryError,
    ExtensionInventoryItem,
    ExtensionManager,
    FrontendArtifactError,
    FrontendArtifactStore,
)

router = APIRouter(prefix="/app/extensions", tags=["extensions"])


class ExtensionApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class ExtensionServices:
    manager: ExtensionManager
    artifacts: FrontendArtifactStore


_extension_services = ExtensionServices(
    manager=ExtensionManager(
        EXTENSIONS_ROOT,
        ExtensionApprovalStore(EXTENSION_STATE_DIR / "approvals.json"),
    ),
    artifacts=FrontendArtifactStore(
        EXTENSION_STATE_DIR / "frontend-artifacts",
        EXTENSIONS_ROOT,
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


def _serialize_inventory_item(
    item: ExtensionInventoryItem,
    artifacts: FrontendArtifactStore,
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
    return {
        "id": item.extension_id,
        "sourcePath": str(item.package_dir.resolve()),
        "status": item.status,
        "digest": item.digest,
        "errors": list(item.errors),
        "manifest": manifest,
        "approval": approval,
        "frontendEntryUrl": _frontend_entry_url(item, artifacts),
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


@router.get("")
def list_extensions(services: ExtensionServicesDependency):
    try:
        items = services.manager.scan()
    except (ExtensionApprovalStateError, ExtensionInventoryError, OSError) as exc:
        return _inventory_error_response(exc)
    return {
        "extensions": [
            _serialize_inventory_item(item, services.artifacts) for item in items
        ]
    }


@router.post("/{extension_id}/approve")
def approve_extension(
    extension_id: str,
    request: ExtensionApprovalRequest,
    services: ExtensionServicesDependency,
):
    try:
        prepared = services.manager.prepare_approval(extension_id, request.digest)
        services.artifacts.stage(prepared, request.digest)
        services.manager.approve(extension_id, request.digest)
        services.artifacts.prune_other_digests(extension_id, request.digest)
        item = services.manager.get_item(extension_id)
    except ExtensionInventoryError as exc:
        return _mutation_error_response(exc)
    except (ExtensionApprovalStateError, FrontendArtifactError, OSError) as exc:
        return error_response(
            500,
            "extension_approval_failed",
            "Extension approval could not be persisted.",
            retryable=True,
            details={"reason": str(exc)},
        )
    return {"extension": _serialize_inventory_item(item, services.artifacts)}


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
    return {"extension": _serialize_inventory_item(item, services.artifacts)}


@router.delete("/{extension_id}/approval")
def revoke_extension_approval(
    extension_id: str,
    services: ExtensionServicesDependency,
):
    try:
        revoked = services.manager.revoke(extension_id)
        services.artifacts.remove_extension(extension_id)
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
    except (ExtensionApprovalStateError, FrontendArtifactError, OSError) as exc:
        return _inventory_error_response(exc)
    return {"extension": _serialize_inventory_item(item, services.artifacts)}


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
