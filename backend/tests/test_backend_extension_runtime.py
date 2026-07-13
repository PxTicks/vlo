from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.extensions import (
    BackendArtifactError,
    BackendArtifactStore,
    BackendExtensionRuntime,
    ExtensionApprovalStore,
    ExtensionManager,
)
from services.extensions.manifest import EXTENSION_SDK_VERSION


def _create_runtime(
    tmp_path: Path,
    *,
    activation_timeout_seconds: float = 10.0,
) -> tuple[BackendExtensionRuntime, ExtensionManager, BackendArtifactStore, Path]:
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
    )
    artifacts = BackendArtifactStore(
        state_root / "backend-artifacts",
        extensions_root,
    )
    return (
        BackendExtensionRuntime(
            manager,
            artifacts,
            activation_timeout_seconds=activation_timeout_seconds,
        ),
        manager,
        artifacts,
        extensions_root,
    )


def _write_backend_package(
    extensions_root: Path,
    extension_id: str,
    source: str,
    *,
    helper_source: str | None = None,
) -> Path:
    package_dir = extensions_root / extension_id
    module_dir = package_dir / "backend" / "extension"
    module_dir.mkdir(parents=True)
    (module_dir / "__init__.py").write_text(source, encoding="utf-8")
    if helper_source is not None:
        (module_dir / "helper.py").write_text(helper_source, encoding="utf-8")
    manifest = {
        "manifestVersion": 1,
        "id": extension_id,
        "name": f"Test {extension_id}",
        "version": "1.2.3",
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


def _approve(manager: ExtensionManager, extension_id: str) -> str:
    item = manager.get_item(extension_id, force_digest=True)
    assert item.digest is not None
    manager.approve(extension_id, item.digest)
    return item.digest


def test_pending_backend_code_is_not_imported(tmp_path: Path):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    marker = tmp_path / "imported.txt"
    _write_backend_package(
        extensions_root,
        "example.pending",
        (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('imported', encoding='utf-8')\n"
            "def create_extension(_context):\n"
            "    return None\n"
        ),
    )

    item = manager.scan()[0]
    summary = asyncio.run(runtime.start(FastAPI()))

    assert item.status == "pending_approval"
    assert summary.records == ()
    assert marker.exists() is False
    assert runtime.describe(item).status == "inactive"


def test_approved_backend_activates_from_staged_digest_with_relative_imports(
    tmp_path: Path,
):
    runtime, manager, artifacts, extensions_root = _create_runtime(tmp_path)
    marker = tmp_path / "activated.txt"
    _write_backend_package(
        extensions_root,
        "example.active",
        (
            "from pathlib import Path\n"
            "from fastapi import APIRouter\n"
            "from .helper import VALUE\n"
            "router = APIRouter()\n"
            "@router.get('/value')\n"
            "def get_value():\n"
            "    return {'value': VALUE}\n"
            "def create_extension(context):\n"
            f"    Path({str(marker)!r}).write_text(\n"
            "        f'{context.extension.id}|{context.extension.version}|'\n"
            "        f'{context.sdk_version}|{context.package_dir.name}',\n"
            "        encoding='utf-8',\n"
            "    )\n"
            "    return router\n"
        ),
        helper_source="VALUE = 42\n",
    )
    digest = _approve(manager, "example.active")
    app = FastAPI()

    @app.get("/{full_path:path}")
    def frontend_fallback(full_path: str):
        return {"path": full_path}

    summary = asyncio.run(runtime.start(app))

    assert [(record.extension_id, record.status) for record in summary.records] == [
        ("example.active", "active")
    ]
    assert marker.read_text(encoding="utf-8") == (
        f"example.active|1.2.3|{EXTENSION_SDK_VERSION}|{digest.removeprefix('sha256:')}"
    )
    route_paths = [route.path for route in app.routes]
    extension_route = "/app/extensions/example.active/api/value"
    assert extension_route in route_paths
    assert route_paths.index(extension_route) < route_paths.index("/{full_path:path}")
    item = manager.scan()[0]
    runtime_view = runtime.describe(item)
    assert runtime_view.status == "active"
    assert runtime_view.digest == digest
    assert artifacts.verify(
        "example.active",
        digest,
        "backend.extension:create_extension",
    ).package_dir.is_dir()
    assert asyncio.run(runtime.stop()) == ()


def test_activation_failure_is_isolated_from_other_extensions(tmp_path: Path):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    healthy_marker = tmp_path / "healthy.txt"
    _write_backend_package(
        extensions_root,
        "example.broken",
        (
            "def create_extension(_context):\n"
            "    raise RuntimeError('broken on purpose')\n"
        ),
    )
    _write_backend_package(
        extensions_root,
        "example.healthy",
        (
            "from pathlib import Path\n"
            "def create_extension(_context):\n"
            f"    Path({str(healthy_marker)!r}).write_text('ok', encoding='utf-8')\n"
        ),
    )
    _approve(manager, "example.broken")
    _approve(manager, "example.healthy")

    summary = asyncio.run(runtime.start(FastAPI()))

    assert [(record.extension_id, record.status) for record in summary.records] == [
        ("example.broken", "failed"),
        ("example.healthy", "active"),
    ]
    assert "broken on purpose" in summary.records[0].message
    assert healthy_marker.read_text(encoding="utf-8") == "ok"
    assert asyncio.run(runtime.stop()) == ()


def test_hung_synchronous_factory_times_out_without_blocking_later_extensions(
    tmp_path: Path,
):
    runtime, manager, _artifacts, extensions_root = _create_runtime(
        tmp_path,
        activation_timeout_seconds=0.03,
    )
    late_marker = tmp_path / "late-side-effect.txt"
    release_marker = tmp_path / "release-hung-factory.txt"
    healthy_marker = tmp_path / "healthy-after-timeout.txt"
    _write_backend_package(
        extensions_root,
        "example.a-hung",
        (
            "import time\n"
            "from pathlib import Path\n"
            "def create_extension(_context):\n"
            f"    while not Path({str(release_marker)!r}).exists():\n"
            "        time.sleep(0.01)\n"
            f"    Path({str(late_marker)!r}).write_text('late', encoding='utf-8')\n"
        ),
    )
    _write_backend_package(
        extensions_root,
        "example.b-healthy",
        (
            "from pathlib import Path\n"
            "def create_extension(_context):\n"
            f"    Path({str(healthy_marker)!r}).write_text('ok', encoding='utf-8')\n"
        ),
    )
    _approve(manager, "example.a-hung")
    _approve(manager, "example.b-healthy")

    summary = asyncio.run(runtime.start(FastAPI()))

    assert [(record.extension_id, record.status) for record in summary.records] == [
        ("example.a-hung", "failed"),
        ("example.b-healthy", "active"),
    ]
    assert "cannot be forcibly terminated" in summary.records[0].message
    assert healthy_marker.read_text(encoding="utf-8") == "ok"
    assert late_marker.exists() is False

    # A timeout protects host availability; it cannot undo trusted Python work
    # already executing in the abandoned daemon thread.
    release_marker.write_text("release\n", encoding="utf-8")
    for _attempt in range(100):
        if late_marker.exists():
            break
        time.sleep(0.01)
    assert late_marker.read_text(encoding="utf-8") == "late"
    assert asyncio.run(runtime.stop()) == ()


def test_backend_runtime_rechecks_sdk_compatibility_before_import(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    marker = tmp_path / "incompatible-import.txt"
    _write_backend_package(
        extensions_root,
        "example.incompatible-runtime",
        (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('imported', encoding='utf-8')\n"
            "def create_extension(_context):\n"
            "    return None\n"
        ),
    )
    _approve(manager, "example.incompatible-runtime")
    approved = manager.scan(force_digest=True)[0]
    assert approved.manifest is not None
    incompatible_manifest = approved.manifest.model_copy(
        update={"sdk": ">=2.0.0"}
    )
    incompatible_item = replace(approved, manifest=incompatible_manifest)
    monkeypatch.setattr(
        manager,
        "scan",
        lambda *, force_digest=False: [incompatible_item],
    )

    summary = asyncio.run(runtime.start(FastAPI()))

    assert summary.records[0].status == "failed"
    assert (
        f"does not include host SDK {EXTENSION_SDK_VERSION}"
        in summary.records[0].message
    )
    assert marker.exists() is False


def test_cooperative_async_factory_is_cancelled_at_activation_timeout(
    tmp_path: Path,
):
    runtime, manager, _artifacts, extensions_root = _create_runtime(
        tmp_path,
        activation_timeout_seconds=0.03,
    )
    _write_backend_package(
        extensions_root,
        "example.async-timeout",
        (
            "import asyncio\n"
            "async def create_extension(_context):\n"
            "    await asyncio.Event().wait()\n"
        ),
    )
    _approve(manager, "example.async-timeout")

    summary = asyncio.run(runtime.start(FastAPI()))

    assert summary.records[0].status == "failed"
    assert "exceeded 0.03 seconds" in summary.records[0].message


def test_invalid_router_rolls_back_extension_shutdown(tmp_path: Path):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    rollback_marker = tmp_path / "rolled-back.txt"
    _write_backend_package(
        extensions_root,
        "example.routes",
        (
            "from pathlib import Path\n"
            "from fastapi import APIRouter\n"
            "from services.extensions import BackendExtensionDefinition\n"
            "router = APIRouter()\n"
            "@router.get('/same')\n"
            "def first():\n"
            "    return 1\n"
            "@router.get('/same')\n"
            "def second():\n"
            "    return 2\n"
            "def create_extension(_context):\n"
            "    def shutdown():\n"
            f"        Path({str(rollback_marker)!r}).write_text('yes', encoding='utf-8')\n"
            "    return BackendExtensionDefinition(router=router, shutdown=shutdown)\n"
        ),
    )
    _approve(manager, "example.routes")
    app = FastAPI()

    summary = asyncio.run(runtime.start(app))

    assert summary.records[0].status == "failed"
    assert "duplicate extension route" in summary.records[0].message
    assert rollback_marker.read_text(encoding="utf-8") == "yes"
    assert not any(
        route.path.startswith("/app/extensions/example.routes/api")
        for route in app.routes
    )


def test_shutdown_runs_in_reverse_activation_order(tmp_path: Path):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    shutdown_log = tmp_path / "shutdown.log"
    for extension_id in ("example.first", "example.second"):
        _write_backend_package(
            extensions_root,
            extension_id,
            (
                "from pathlib import Path\n"
                "from services.extensions import BackendExtensionDefinition\n"
                "def create_extension(_context):\n"
                "    def shutdown():\n"
                f"        with Path({str(shutdown_log)!r}).open('a', encoding='utf-8') as output:\n"
                f"            output.write({extension_id!r} + '\\n')\n"
                "    return BackendExtensionDefinition(shutdown=shutdown)\n"
            ),
        )
        _approve(manager, extension_id)

    asyncio.run(runtime.start(FastAPI()))
    errors = asyncio.run(runtime.stop())

    assert errors == ()
    assert shutdown_log.read_text(encoding="utf-8").splitlines() == [
        "example.second",
        "example.first",
    ]


def test_corrupt_staged_source_fails_closed_without_import(tmp_path: Path):
    runtime, manager, artifacts, extensions_root = _create_runtime(tmp_path)
    marker = tmp_path / "should-not-exist.txt"
    _write_backend_package(
        extensions_root,
        "example.corrupt",
        (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('imported', encoding='utf-8')\n"
            "def create_extension(_context):\n"
            "    return None\n"
        ),
    )
    digest = _approve(manager, "example.corrupt")
    item = manager.get_item("example.corrupt", force_digest=True)
    staged = artifacts.stage(item, digest)
    assert staged is not None
    staged_source = staged.package_dir / "backend" / "extension" / "__init__.py"
    staged_source.write_text("CORRUPTED = True\n", encoding="utf-8")

    summary = asyncio.run(runtime.start(FastAPI()))

    assert summary.records[0].status == "failed"
    assert "corrupt" in summary.records[0].message
    assert marker.exists() is False
    with pytest.raises(BackendArtifactError, match="corrupt"):
        artifacts.verify(
            "example.corrupt",
            digest,
            "backend.extension:create_extension",
        )


def test_generated_bytecode_does_not_invalidate_staged_source(tmp_path: Path):
    _runtime, manager, artifacts, extensions_root = _create_runtime(tmp_path)
    _write_backend_package(
        extensions_root,
        "example.cache",
        "def create_extension(_context):\n    return None\n",
    )
    digest = _approve(manager, "example.cache")
    item = manager.get_item("example.cache", force_digest=True)
    staged = artifacts.stage(item, digest)
    assert staged is not None
    cache = staged.package_dir / "backend" / "extension" / "__pycache__"
    cache.mkdir()
    (cache / "extension.pyc").write_bytes(b"generated")

    verified = artifacts.verify(
        "example.cache",
        digest,
        "backend.extension:create_extension",
    )

    assert verified == staged


def test_changed_approved_package_is_not_activated(tmp_path: Path):
    runtime, manager, _artifacts, extensions_root = _create_runtime(tmp_path)
    marker = tmp_path / "changed.txt"
    package_dir = _write_backend_package(
        extensions_root,
        "example.changed",
        (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('imported', encoding='utf-8')\n"
            "def create_extension(_context):\n"
            "    return None\n"
        ),
    )
    _approve(manager, "example.changed")
    (package_dir / "unapproved.txt").write_text("new bytes\n", encoding="utf-8")

    summary = asyncio.run(runtime.start(FastAPI()))

    assert summary.records == ()
    assert marker.exists() is False
    changed = manager.scan()[0]
    assert changed.status == "changed"
    assert runtime.describe(changed).status == "inactive"


def test_backend_artifact_store_must_live_outside_extension_tree(tmp_path: Path):
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()

    with pytest.raises(BackendArtifactError, match="outside"):
        BackendArtifactStore(
            extensions_root / ".backend-artifacts",
            extensions_root,
        )
