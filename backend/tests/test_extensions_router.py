from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import services.extensions.package_digest as package_digest_module
from routers.extensions import (
    ExtensionApprovalRequest,
    ExtensionServices,
    approve_extension,
    disable_extension,
    get_frontend_artifact,
    list_extensions,
    revoke_extension_approval,
    router,
)
from services.extensions import (
    BackendArtifactStore,
    BackendExtensionRuntime,
    ExtensionApprovalStore,
    FrontendArtifactError,
    ExtensionManager,
    FrontendArtifactStore,
)


def _create_package(extensions_root: Path, extension_id: str) -> Path:
    package_dir = extensions_root / extension_id
    entry = package_dir / "frontend" / "dist" / "index.js"
    chunk = package_dir / "frontend" / "dist" / "assets" / "chunk.js"
    entry.parent.mkdir(parents=True)
    chunk.parent.mkdir(parents=True)
    entry.write_text(
        'import "./assets/chunk.js";\nexport function activate() {}\n',
        encoding="utf-8",
    )
    chunk.write_text("export const chunk = 1;\n", encoding="utf-8")
    (package_dir / "backend-secret.txt").write_text("not public\n", encoding="utf-8")
    manifest = {
        "manifestVersion": 1,
        "id": extension_id,
        "name": "Router Test Extension",
        "version": "1.0.0",
        "sdk": ">=1.0.0 <2.0.0",
        "frontend": {"entry": "frontend/dist/index.js"},
        "capabilities": ["timeline.read"],
    }
    (package_dir / "manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    return package_dir


def _create_backend_package(extensions_root: Path, extension_id: str) -> Path:
    package_dir = extensions_root / extension_id
    entry = package_dir / "backend" / "extension" / "__init__.py"
    entry.parent.mkdir(parents=True)
    entry.write_text(
        "def create_extension(_context):\n    return None\n",
        encoding="utf-8",
    )
    manifest = {
        "manifestVersion": 1,
        "id": extension_id,
        "name": "Backend Router Test Extension",
        "version": "1.0.0",
        "sdk": ">=1.0.0 <2.0.0",
        "backend": {
            "mode": "in_process",
            "entry": "backend.extension:create_extension",
        },
        "capabilities": ["backend.jobs"],
    }
    (package_dir / "manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    return package_dir


def _create_services(
    tmp_path: Path,
) -> tuple[ExtensionServices, Path, Path]:
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json", now=lambda: 10.0),
    )
    backend_artifacts = BackendArtifactStore(
        state_root / "backend-artifacts",
        extensions_root,
    )
    services = ExtensionServices(
        manager=manager,
        artifacts=FrontendArtifactStore(
            state_root / "frontend-artifacts",
            extensions_root,
        ),
        backend_artifacts=backend_artifacts,
        backend_runtime=BackendExtensionRuntime(manager, backend_artifacts),
    )
    return services, extensions_root, state_root


def _json_response(response: JSONResponse) -> dict[str, object]:
    return json.loads(response.body.decode("utf-8"))


def _approve(
    services: ExtensionServices,
    extension_id: str,
    digest: str,
) -> dict[str, object]:
    response = approve_extension(
        extension_id,
        ExtensionApprovalRequest(digest=digest),
        services,
    )
    assert isinstance(response, dict)
    return response["extension"]


def test_router_registers_management_and_artifact_paths():
    route_paths = {route.path for route in router.routes}

    assert route_paths == {
        "/app/extensions",
        "/app/extensions/{extension_id}/approve",
        "/app/extensions/{extension_id}/disable",
        "/app/extensions/{extension_id}/approval",
        "/app/extensions/{extension_id}/frontend/{digest}/{artifact_path:path}",
    }


def test_inventory_approval_and_immutable_artifact_delivery(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    package_dir = _create_package(extensions_root, "example.router")

    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]
    assert pending["status"] == "pending_approval"
    assert pending["frontendEntryUrl"] is None
    assert pending["sourcePath"] == str(package_dir.resolve())
    assert pending["backendRuntime"]["status"] == "not_declared"

    approved = _approve(services, "example.router", pending["digest"])
    assert approved["status"] == "approved"
    assert approved["approval"] == {
        "digest": pending["digest"],
        "version": "1.0.0",
        "approvedAt": 10.0,
        "enabled": True,
    }
    assert approved["frontendEntryUrl"].endswith("/index.js")

    entry_response = get_frontend_artifact(
        "example.router",
        pending["digest"],
        "index.js",
        services,
    )
    assert isinstance(entry_response, Response)
    assert entry_response.status_code == 200
    assert entry_response.body.startswith(b'import "./assets/chunk.js";')
    assert entry_response.headers["cache-control"] == (
        "public, max-age=31536000, immutable"
    )
    assert entry_response.headers["x-content-type-options"] == "nosniff"
    assert entry_response.headers["etag"] == f'"{pending["digest"]}"'
    assert entry_response.headers["content-type"].startswith("text/javascript")

    chunk_response = get_frontend_artifact(
        "example.router",
        pending["digest"],
        "assets/chunk.js",
        services,
    )
    assert isinstance(chunk_response, Response)
    assert chunk_response.body == b"export const chunk = 1;\n"

    staged_root = state_root / "frontend-artifacts"
    assert staged_root.is_dir()
    assert not staged_root.is_relative_to(extensions_root)


def test_changed_package_loses_entry_url_and_artifact_access(tmp_path: Path):
    services, extensions_root, _state_root = _create_services(tmp_path)
    package_dir = _create_package(extensions_root, "example.changed")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]
    _approve(services, "example.changed", pending["digest"])

    (package_dir / "frontend" / "dist" / "index.js").write_text(
        "export const changed = true;\n",
        encoding="utf-8",
    )

    changed_inventory = list_extensions(services)
    assert isinstance(changed_inventory, dict)
    changed = changed_inventory["extensions"][0]
    assert changed["status"] == "changed"
    assert changed["frontendEntryUrl"] is None

    denied = get_frontend_artifact(
        "example.changed",
        pending["digest"],
        "index.js",
        services,
    )
    assert isinstance(denied, JSONResponse)
    assert denied.status_code == 404
    assert _json_response(denied)["error"]["code"] == (
        "extension_artifact_not_found"
    )


def test_backend_approval_stages_code_and_reports_restart_readiness(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    _create_backend_package(extensions_root, "example.backend")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]

    assert pending["backendRuntime"]["status"] == "inactive"
    approved = _approve(services, "example.backend", pending["digest"])

    assert approved["backendRuntime"] == {
        "status": "restart_required",
        "message": "Approved backend code will activate after restart.",
        "digest": pending["digest"],
    }
    staged = (
        state_root
        / "backend-artifacts"
        / "example.backend"
        / pending["digest"].removeprefix("sha256:")
    )
    assert (staged / "backend" / "extension" / "__init__.py").is_file()
    assert not (staged / "manifest.json").exists()

    summary = asyncio.run(services.backend_runtime.start(FastAPI()))
    assert summary.records[0].status == "active"
    active_inventory = list_extensions(services)
    assert isinstance(active_inventory, dict)
    assert active_inventory["extensions"][0]["backendRuntime"] == {
        "status": "active",
        "message": "Backend extension is active.",
        "digest": pending["digest"],
    }

    revoked = revoke_extension_approval("example.backend", services)

    assert isinstance(revoked, dict)
    assert revoked["extension"]["backendRuntime"]["status"] == (
        "restart_required"
    )
    assert staged.parent.exists()
    assert asyncio.run(services.backend_runtime.stop()) == ()
    assert not staged.parent.exists()


def test_backend_reapproval_retains_active_digest_until_shutdown(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    package_dir = _create_backend_package(extensions_root, "example.running-update")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    first_digest = inventory["extensions"][0]["digest"]
    _approve(services, "example.running-update", first_digest)
    asyncio.run(services.backend_runtime.start(FastAPI()))

    entry = package_dir / "backend" / "extension" / "__init__.py"
    entry.write_text(
        "def create_extension(_context):\n    return None  # updated\n",
        encoding="utf-8",
    )
    changed = list_extensions(services)
    assert isinstance(changed, dict)
    second_digest = changed["extensions"][0]["digest"]
    _approve(services, "example.running-update", second_digest)
    artifact_root = (
        state_root / "backend-artifacts" / "example.running-update"
    )

    assert {path.name for path in artifact_root.iterdir()} == {
        first_digest.removeprefix("sha256:"),
        second_digest.removeprefix("sha256:"),
    }
    assert asyncio.run(services.backend_runtime.stop()) == ()
    assert {path.name for path in artifact_root.iterdir()} == {
        second_digest.removeprefix("sha256:")
    }


def test_backend_reapproval_prunes_superseded_staged_digest(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    package_dir = _create_backend_package(extensions_root, "example.backend-update")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    first_digest = inventory["extensions"][0]["digest"]
    _approve(services, "example.backend-update", first_digest)

    entry = package_dir / "backend" / "extension" / "__init__.py"
    entry.write_text(
        "def create_extension(_context):\n    return {'updated': True}\n",
        encoding="utf-8",
    )
    changed = list_extensions(services)
    assert isinstance(changed, dict)
    second_digest = changed["extensions"][0]["digest"]
    assert second_digest != first_digest

    _approve(services, "example.backend-update", second_digest)

    extension_artifacts = (
        state_root / "backend-artifacts" / "example.backend-update"
    )
    assert {path.name for path in extension_artifacts.iterdir()} == {
        second_digest.removeprefix("sha256:")
    }


def test_disable_and_revoke_remove_artifact_access(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    _create_package(extensions_root, "example.toggle")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]
    _approve(services, "example.toggle", pending["digest"])
    artifact_root = state_root / "frontend-artifacts" / "example.toggle"
    assert artifact_root.is_dir()

    disabled_response = disable_extension("example.toggle", services)
    assert isinstance(disabled_response, dict)
    assert disabled_response["extension"]["status"] == "disabled"
    assert disabled_response["extension"]["frontendEntryUrl"] is None

    denied = get_frontend_artifact(
        "example.toggle",
        pending["digest"],
        "index.js",
        services,
    )
    assert isinstance(denied, JSONResponse)
    assert denied.status_code == 404
    assert artifact_root.is_dir()

    revoked_response = revoke_extension_approval("example.toggle", services)
    assert isinstance(revoked_response, dict)
    assert revoked_response["extension"]["status"] == "pending_approval"
    assert not artifact_root.exists()


def test_reapproval_prunes_superseded_artifact_digest(tmp_path: Path):
    services, extensions_root, state_root = _create_services(tmp_path)
    package_dir = _create_package(extensions_root, "example.updated")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    first_digest = inventory["extensions"][0]["digest"]
    _approve(services, "example.updated", first_digest)

    (package_dir / "frontend" / "dist" / "index.js").write_text(
        "export const updatedBundleHasDifferentBytes = true;\n",
        encoding="utf-8",
    )
    changed_inventory = list_extensions(services)
    assert isinstance(changed_inventory, dict)
    second_digest = changed_inventory["extensions"][0]["digest"]
    assert second_digest != first_digest

    _approve(services, "example.updated", second_digest)

    extension_artifacts = (
        state_root / "frontend-artifacts" / "example.updated"
    )
    assert {path.name for path in extension_artifacts.iterdir()} == {
        second_digest.removeprefix("sha256:")
    }


def test_staging_walk_count_does_not_scale_with_bundle_file_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    services, extensions_root, _state_root = _create_services(tmp_path)
    package_dir = _create_package(extensions_root, "example.large")
    assets = package_dir / "frontend" / "dist" / "assets"
    for index in range(100):
        (assets / f"chunk-{index}.js").write_text(
            f"export const chunk{index} = {index};\n",
            encoding="utf-8",
        )

    prepared = services.manager.scan(force_digest=True)[0]
    assert prepared.digest is not None
    real_iter_package_files = package_digest_module._iter_package_files
    walk_count = 0

    def count_package_walks(package_path: Path):
        nonlocal walk_count
        walk_count += 1
        return real_iter_package_files(package_path)

    monkeypatch.setattr(
        package_digest_module,
        "_iter_package_files",
        count_package_walks,
    )

    services.artifacts.stage(prepared, prepared.digest)

    assert walk_count == 5


def test_approval_rejects_stale_digest_and_unknown_fields(tmp_path: Path):
    services, extensions_root, _state_root = _create_services(tmp_path)
    package_dir = _create_package(extensions_root, "example.stale")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]
    (package_dir / "frontend" / "dist" / "index.js").write_text(
        "export const changed = true;\n",
        encoding="utf-8",
    )

    stale = approve_extension(
        "example.stale",
        ExtensionApprovalRequest(digest=pending["digest"]),
        services,
    )
    assert isinstance(stale, JSONResponse)
    assert stale.status_code == 409
    assert _json_response(stale)["error"]["code"] == "extension_state_conflict"

    with pytest.raises(ValidationError):
        ExtensionApprovalRequest.model_validate(
            {
                "digest": pending["digest"],
                "approveAnything": True,
            }
        )
    with pytest.raises(ValidationError):
        ExtensionApprovalRequest(digest="x" * 71)


def test_artifact_route_never_exposes_files_outside_frontend_dist(tmp_path: Path):
    services, extensions_root, _state_root = _create_services(tmp_path)
    _create_package(extensions_root, "example.private")
    inventory = list_extensions(services)
    assert isinstance(inventory, dict)
    pending = inventory["extensions"][0]
    _approve(services, "example.private", pending["digest"])

    response = get_frontend_artifact(
        "example.private",
        pending["digest"],
        "backend-secret.txt",
        services,
    )

    assert isinstance(response, JSONResponse)
    assert response.status_code == 404
    assert b"not public" not in response.body


def test_corrupt_approval_state_returns_structured_inventory_error(tmp_path: Path):
    services, _extensions_root, state_root = _create_services(tmp_path)
    state_root.mkdir(exist_ok=True)
    (state_root / "approvals.json").write_text("not json", encoding="utf-8")

    response = list_extensions(services)

    assert isinstance(response, JSONResponse)
    assert response.status_code == 500
    assert _json_response(response)["error"]["code"] == (
        "extension_inventory_unavailable"
    )


def test_artifact_store_must_live_outside_extension_tree(tmp_path: Path):
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()

    with pytest.raises(FrontendArtifactError, match="outside"):
        FrontendArtifactStore(
            extensions_root / ".artifacts",
            extensions_root,
        )


def test_artifact_store_rejects_escaping_identifiers_and_paths(tmp_path: Path):
    services, _extensions_root, _state_root = _create_services(tmp_path)
    digest = "sha256:" + "a" * 64

    with pytest.raises(FrontendArtifactError, match="extension ID"):
        services.artifacts.read("..", digest, "index.js")
    with pytest.raises(FrontendArtifactError, match="artifact path"):
        services.artifacts.read("example.safe", digest, "../secret.txt")
