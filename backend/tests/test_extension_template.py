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
from services.extensions.manifest import EXTENSION_SDK_VERSION

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_ROOT = REPOSITORY_ROOT / "extension-template"
COLOR_GRADE_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "color-grade"
)
TRACKING_FIXTURE_ROOT = REPOSITORY_ROOT / "extension-fixtures" / "tracking"
LAYOUT_PROMPT_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "layout-prompt"
)
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


def _copy_color_grade_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "color-grade"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(COLOR_GRADE_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_tracking_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "tracking"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(TRACKING_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_layout_prompt_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "layout-prompt"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(LAYOUT_PROMPT_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


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
        "sdkVersion": EXTENSION_SDK_VERSION,
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


def test_color_grade_fixture_builds_registers_and_stages_through_approval(
    tmp_path: Path,
):
    fixture = _copy_color_grade_fixture_workspace(tmp_path)
    _build_template(fixture)
    built_entry = fixture / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()

    frontend_smoke = _run_node(
        [
            "--input-type=module",
            "--eval",
            (
                f"const extension = await import({json.dumps(built_entry.as_uri())});"
                "const transformations = []; const components = []; const entities = []; const logs = [];"
                "const transitions = [];"
                "let filterOptions; const hostFilter = {};"
                "await extension.activate({"
                "extension: { id: 'example.color-grade', version: '1.0.0' },"
                "sdkVersion: '1.0.0', signal: new AbortController().signal,"
                "api: {"
                "runtime: { pixi: { Filter: { from(options) { filterOptions = options; return hostFilter; } },"
                "Graphics: class { clear() { return this; } rect() { return this; } roundRect() { return this; } fill() { return this; } } },"
                "react: { createElement() { return {}; } } },"
                "transformations: { register(definition) {"
                "transformations.push(definition);"
                "return { id: 'example.color-grade/' + definition.id, dispose() {} };"
                "} },"
                "ui: { registerComponent(definition) { components.push(definition);"
                "return { id: 'example.color-grade/' + definition.id, dispose() {} };"
                "} },"
                "transitions: { register(definition) { transitions.push(definition);"
                "return { id: 'example.color-grade/' + definition.id, dispose() {} };"
                "} },"
                "timeline: { ticksPerSecond: 1000, transaction() { return { ok: true }; } },"
                "entityProviders: { register(definition) { entities.push(definition);"
                "return { id: 'example.color-grade/' + definition.id, dispose() {} };"
                "} }"
                "},"
                "logger: { debug() {}, info(message) { logs.push(message); },"
                "warn() {}, error() {} }, onDispose() {}"
                "});"
                "if (transformations[0]?.kind !== 'trusted-filter' || "
                "typeof transformations[0]?.createFilter !== 'function') "
                "throw new Error('color-grade transformation missing');"
                "const filterInstance = transformations[0].createFilter();"
                "if (filterInstance.object !== hostFilter) "
                "throw new Error('trusted Pixi object lifecycle missing');"
                "filterInstance.update({ exposure: 1, contrast: 1.2, saturation: 0.8 });"
                "if (!filterOptions?.gl?.fragment?.includes('uExposure')) "
                "throw new Error('custom GLSL was not constructed through host Pixi');"
                "if (components[0]?.kind !== 'trusted-react') "
                "throw new Error('color-grade trusted UI missing');"
                "if (entities[0]?.kind !== 'trusted-pixi' || "
                "typeof entities[0]?.createRenderable !== 'function') "
                "throw new Error('trusted entity provider missing');"
                "const entityInstance = entities[0].createRenderable();"
                "entityInstance.update({ data: entities[0].defaultPayload, schemaVersion: 1 }, {});"
                "if (typeof entities[0]?.inspector !== 'function') "
                "throw new Error('trusted entity inspector missing');"
                "if (entities[1]?.label !== 'Animated progress') "
                "throw new Error('second trusted entity provider missing');"
                "const progressInstance = entities[1].createRenderable();"
                "progressInstance.update({ data: entities[1].defaultPayload, schemaVersion: 1 },"
                "{ entity: { durationTicks: 100 }, frame: { visualTimeTicks: 50 } });"
                "if (!logs.some((message) => message.includes('activated'))) "
                "throw new Error('activation log missing');"
            ),
        ],
        cwd=fixture,
    )
    _assert_command_succeeded(frontend_smoke)

    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    shutil.copytree(fixture, extensions_root / "example.color-grade")
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
    )
    frontend_artifacts = FrontendArtifactStore(
        state_root / "frontend-artifacts",
        extensions_root,
    )

    pending = manager.scan(force_digest=True)[0]
    assert pending.extension_id == "example.color-grade"
    assert pending.status == "pending_approval"
    assert pending.digest is not None

    frontend_artifacts.stage(pending, pending.digest)
    manager.approve(pending.extension_id, pending.digest)
    approved = manager.get_item(pending.extension_id, force_digest=True)
    assert approved.status == "approved"
    frontend_bundle = frontend_artifacts.read(
        pending.extension_id,
        pending.digest,
        "index.js",
    )
    assert b"Custom GLSL color-grade fixture activated" in frontend_bundle
    assert b"trusted-filter" in frontend_bundle
    assert b"example-color-grade" in frontend_bundle


def test_tracking_fixture_runs_cancellable_job_through_approval_path(
    tmp_path: Path,
):
    fixture = _copy_tracking_fixture_workspace(tmp_path)
    _build_template(fixture)
    built_entry = fixture / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()
    assert b"Tracking conformance fixture" in built_entry.read_bytes()

    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    shutil.copytree(fixture, extensions_root / "example.tracking")
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
    pending = manager.scan(force_digest=True)[0]
    assert pending.digest is not None
    frontend_artifacts.stage(pending, pending.digest)
    backend_artifacts.stage(pending, pending.digest)
    manager.approve(pending.extension_id, pending.digest)

    async def scenario() -> None:
        summary = await runtime.start(FastAPI())
        assert summary.records[0].status == "active"
        job_type = (await runtime.jobs.list_job_types("example.tracking"))[0]
        assert job_type == {
            "id": "track",
            "label": "Track fixture target",
            "timeoutSeconds": 30,
            "readiness": {
                "ready": True,
                "message": "Synthetic fixture tracker is ready",
                "details": {
                    "model": "fixture-motion-v1",
                    "device": "cpu",
                    "purpose": "extension conformance",
                },
            },
        }
        uploaded = runtime.jobs.upload_input(
            "example.tracking",
            b"fixture-video-bytes",
            filename="source.mp4",
            content_type="video/mp4",
        )
        job_input = {
            "schemaVersion": 1,
            "sampleCount": 24,
            "source": {
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "startTicks": 0,
                "endTicks": 192_000,
                "ticksPerSecond": 96_000,
            },
            "target": {"id": "face-1", "label": "Face"},
        }
        submitted = await runtime.jobs.submit(
            "example.tracking",
            "track",
            job_input,
            (uploaded.artifact_id,),
        )
        snapshots = []
        for _attempt in range(200):
            snapshot = runtime.jobs.get(
                "example.tracking",
                submitted.identity.job_id,
            )
            snapshots.append(snapshot)
            if snapshot.status in ("succeeded", "failed", "cancelled"):
                break
            await asyncio.sleep(0.005)
        assert snapshot.status == "succeeded"
        assert any(item.progress > 0 for item in snapshots)
        assert snapshot.result is not None
        assert snapshot.result["coordinateSpace"] == "source-pixels"
        assert snapshot.result["timebase"] == {"kind": "frames", "fps": 30.0}
        assert len(snapshot.result["samples"]) == 24
        assert snapshot.diagnostics[0].message == "Source artifact accepted"
        artifact_id = snapshot.result["artifactId"]
        artifact, content = runtime.jobs.get_artifact(
            "example.tracking",
            artifact_id,
        )
        assert artifact.filename == "tracking-result.json"
        assert json.loads(content)["target"] == {"id": "face-1", "label": "Face"}

        cancellable_upload = runtime.jobs.upload_input(
            "example.tracking",
            b"second-source",
            filename="source.mp4",
            content_type="video/mp4",
        )
        cancellable_input = {**job_input, "sampleCount": 240}
        cancellable = await runtime.jobs.submit(
            "example.tracking",
            "track",
            cancellable_input,
            (cancellable_upload.artifact_id,),
        )
        await asyncio.sleep(0.02)
        cancelled = await runtime.jobs.cancel(
            "example.tracking",
            cancellable.identity.job_id,
        )
        assert cancelled.status == "cancelled"
        assert cancelled.cancel_requested is True
        await runtime.stop()

    asyncio.run(scenario())


def test_layout_prompt_fixture_builds_and_stages_through_approval(
    tmp_path: Path,
):
    fixture = _copy_layout_prompt_fixture_workspace(tmp_path)
    _build_template(fixture)
    built_entry = fixture / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()
    assert b"Layout prompt" in built_entry.read_bytes()
    assert b"generation.toolbar" in built_entry.read_bytes()

    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    shutil.copytree(fixture, extensions_root / "example.layout-prompt")
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
    )
    artifacts = FrontendArtifactStore(
        state_root / "frontend-artifacts",
        extensions_root,
    )
    pending = manager.scan(force_digest=True)[0]
    assert pending.extension_id == "example.layout-prompt"
    assert pending.digest is not None
    artifacts.stage(pending, pending.digest)
    manager.approve(pending.extension_id, pending.digest)

    bundle = artifacts.read(
        pending.extension_id,
        pending.digest,
        "index.js",
    )
    assert b"Visual layout prompt" in bundle
    assert b"Apply JSON prompt" in bundle
