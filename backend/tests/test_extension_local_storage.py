from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers.extensions import (
    ExtensionServices,
    get_extension_services,
    router,
)
from services.extensions import (
    BackendArtifactStore,
    BackendExtensionRuntime,
    ExtensionApprovalStore,
    ExtensionManager,
    FrontendArtifactStore,
)
from services.extensions.local_storage import (
    ExtensionLocalStorageError,
    ExtensionLocalStorageStore,
)

EXTENSION_ID = "example.tags"


def test_store_round_trips_values_per_extension(tmp_path: Path) -> None:
    store = ExtensionLocalStorageStore(tmp_path / "local-storage")

    async def scenario() -> None:
        assert await store.list_keys(EXTENSION_ID) == []
        await store.set(EXTENSION_ID, "theme", {"mode": "dark"})
        await store.set("example.other", "theme", "light")

        present, value = await store.get(EXTENSION_ID, "theme")
        assert present and value == {"mode": "dark"}
        assert await store.list_keys(EXTENSION_ID) == ["theme"]
        # Namespaces are per extension.
        present, value = await store.get("example.other", "theme")
        assert present and value == "light"

        await store.delete(EXTENSION_ID, "theme")
        present, _ = await store.get(EXTENSION_ID, "theme")
        assert not present
        # Deleting the last key removes the document file.
        assert not (tmp_path / "local-storage" / f"{EXTENSION_ID}.json").exists()

    asyncio.run(scenario())


def test_store_rejects_invalid_ids_keys_and_budget(tmp_path: Path) -> None:
    store = ExtensionLocalStorageStore(tmp_path / "local-storage")

    async def scenario() -> None:
        with pytest.raises(ExtensionLocalStorageError):
            await store.set("../escape", "key", 1)
        with pytest.raises(ExtensionLocalStorageError):
            await store.set(EXTENSION_ID, "", 1)
        with pytest.raises(ExtensionLocalStorageError):
            await store.set(EXTENSION_ID, "bad/key", 1)
        with pytest.raises(ExtensionLocalStorageError):
            await store.set(EXTENSION_ID, "nan", float("nan"))
        with pytest.raises(ExtensionLocalStorageError) as budget:
            await store.set(EXTENSION_ID, "big", "x" * (5 * 1024 * 1024))
        assert budget.value.status_code == 413
        # Failed writes leave no partial state behind.
        assert await store.list_keys(EXTENSION_ID) == []

    asyncio.run(scenario())


def _build_app(tmp_path: Path) -> FastAPI:
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
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
        local_storage=ExtensionLocalStorageStore(state_root / "local-storage"),
    )
    app = FastAPI()
    app.include_router(router)

    async def override_services() -> ExtensionServices:
        return services

    app.dependency_overrides[get_extension_services] = override_services
    return app


def test_storage_endpoints_round_trip(tmp_path: Path) -> None:
    app = _build_app(tmp_path)

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            base = f"/app/extensions/{EXTENSION_ID}/storage/local"

            response = await client.get(base)
            assert response.status_code == 200
            assert response.json() == {"keys": []}

            response = await client.put(
                f"{base}/theme", json={"value": {"mode": "dark"}}
            )
            assert response.status_code == 204

            response = await client.get(f"{base}/theme")
            assert response.status_code == 200
            assert response.json() == {"value": {"mode": "dark"}}

            response = await client.get(base)
            assert response.json() == {"keys": ["theme"]}

            response = await client.get(f"{base}/missing")
            assert response.status_code == 404

            response = await client.delete(f"{base}/theme")
            assert response.status_code == 204
            response = await client.get(f"{base}/theme")
            assert response.status_code == 404

            # Invalid extension IDs are 404s, and traversal never leaves root.
            response = await client.get(
                "/app/extensions/Bad--ID/storage/local"
            )
            assert response.status_code == 404

    asyncio.run(scenario())


def test_storage_survives_restart_via_document_file(tmp_path: Path) -> None:
    root = tmp_path / "local-storage"
    store = ExtensionLocalStorageStore(root)

    async def write() -> None:
        await store.set(EXTENSION_ID, "count", 3)

    asyncio.run(write())

    document = json.loads((root / f"{EXTENSION_ID}.json").read_text("utf-8"))
    assert document == {"count": 3}

    reopened = ExtensionLocalStorageStore(root)

    async def read() -> None:
        present, value = await reopened.get(EXTENSION_ID, "count")
        assert present and value == 3

    asyncio.run(read())
