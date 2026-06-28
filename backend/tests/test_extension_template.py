from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI

sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.extensions import (
    BackendArtifactStore,
    BackendExtensionRuntime,
    ExtensionApprovalStore,
    ExtensionManager,
    FrontendArtifactStore,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_ROOT = REPOSITORY_ROOT / "extension-template"
SDK_ROOT = REPOSITORY_ROOT / "packages" / "extension-sdk"
NODE_EXECUTABLE = shutil.which("node")
TYPESCRIPT_CLI = (
    REPOSITORY_ROOT / "frontend" / "node_modules" / "typescript" / "bin" / "tsc"
)
VITE_CLI = (
    REPOSITORY_ROOT / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"
)


def _require_frontend_toolchain() -> str:
    if (
        NODE_EXECUTABLE is None
        or not TYPESCRIPT_CLI.is_file()
        or not VITE_CLI.is_file()
    ):
        pytest.skip("frontend Node toolchain is not installed")
    return NODE_EXECUTABLE


def _copy_template_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    template = workspace / "extension-template"
    shutil.copytree(TEMPLATE_ROOT, template)
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return template


def _run_node(
    arguments: list[str],
    *,
    cwd: Path,
) -> subprocess.CompletedProcess[str]:
    node = _require_frontend_toolchain()
    return subprocess.run(
        [node, *arguments],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _assert_command_succeeded(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stdout + result.stderr


def _build_template(template: Path) -> None:
    typecheck = _run_node(
        [str(TYPESCRIPT_CLI), "-p", "tsconfig.json", "--noEmit"],
        cwd=template,
    )
    _assert_command_succeeded(typecheck)
    build = _run_node(
        [str(VITE_CLI), "build", "--config", "vite.config.mjs"],
        cwd=template,
    )
    _assert_command_succeeded(build)


def test_official_template_builds_and_activates_through_approval_path(
    tmp_path: Path,
):
    template = _copy_template_workspace(tmp_path)
    _build_template(template)
    built_entry = template / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()
    assert b"activate" in built_entry.read_bytes()
    frontend_smoke = _run_node(
        [
            "--input-type=module",
            "--eval",
            (
                f"const extension = await import({json.dumps(built_entry.as_uri())});"
                "const messages = [];"
                "const disposers = [];"
                "const controller = new AbortController();"
                "await extension.activate({"
                "extension: { id: 'example.minimal', version: '1.0.0' },"
                "sdkVersion: '1.0.0', signal: controller.signal, api: {},"
                "logger: { debug() {}, info(message) { messages.push(message); },"
                "warn() {}, error() {} },"
                "onDispose(resource) { disposers.push(resource); }"
                "});"
                "if (disposers.length !== 1) throw new Error('cleanup missing');"
                "controller.abort(); await disposers[0]();"
                "if (!messages.some((message) => message.includes('activated'))) "
                "throw new Error('activation log missing');"
            ),
        ],
        cwd=template,
    )
    _assert_command_succeeded(frontend_smoke)

    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    package_dir = extensions_root / "example.minimal"
    shutil.copytree(template, package_dir)
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
    )
    frontend_artifacts = FrontendArtifactStore(
        state_root / "frontend-artifacts",
        extensions_root,
    )
    backend_artifacts = BackendArtifactStore(
        state_root / "backend-artifacts",
        extensions_root,
    )
    runtime = BackendExtensionRuntime(manager, backend_artifacts)
    extension_modules_before_scan = {
        name for name in sys.modules if name.startswith("_vlo_extension_")
    }

    pending = manager.scan(force_digest=True)[0]

    assert pending.status == "pending_approval"
    assert pending.digest is not None
    assert {
        name for name in sys.modules if name.startswith("_vlo_extension_")
    } == extension_modules_before_scan

    frontend_artifacts.stage(pending, pending.digest)
    backend_artifacts.stage(pending, pending.digest)
    manager.approve("example.minimal", pending.digest)
    approved = manager.get_item("example.minimal", force_digest=True)
    assert approved.status == "approved"
    frontend_bundle = frontend_artifacts.read(
        "example.minimal",
        pending.digest,
        "index.js",
    )
    assert b"Minimal frontend extension activated" in frontend_bundle

    app = FastAPI()
    summary = asyncio.run(runtime.start(app))

    assert [(record.extension_id, record.status) for record in summary.records] == [
        ("example.minimal", "active")
    ]
    status_route = next(
        route
        for route in app.routes
        if route.path == "/app/extensions/example.minimal/api/status"
    )
    assert status_route.endpoint() == {
        "extensionId": "example.minimal",
        "version": "1.0.0",
        "sdkVersion": "1.0.0",
    }
    assert asyncio.run(runtime.stop()) == ()


def test_official_template_rejects_duplicate_host_singletons(tmp_path: Path):
    template = _copy_template_workspace(tmp_path)
    entry = template / "frontend" / "src" / "index.ts"
    entry.write_text(
        'import React from "react";\nconsole.log(React);\n',
        encoding="utf-8",
    )

    build = _run_node(
        [str(VITE_CLI), "build", "--config", "vite.config.mjs"],
        cwd=template,
    )

    assert build.returncode != 0
    assert "Host singleton 'react' cannot be imported" in (
        build.stdout + build.stderr
    )
