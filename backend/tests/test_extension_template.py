from __future__ import annotations

import asyncio
import json
import logging
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
TRUSTED_HOST_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "trusted-host-access"
)
LOOK_PACK_FIXTURE_ROOT = REPOSITORY_ROOT / "extension-fixtures" / "look-pack"
FILTER_PACK_FIXTURE_ROOT = REPOSITORY_ROOT / "extension-fixtures" / "filter-pack"
MATRIX_RAIN_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "matrix-rain"
)
GRADING_TOOLS_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "grading-tools"
)
COMMAND_HOTKEYS_FIXTURE_ROOT = (
    REPOSITORY_ROOT / "extension-fixtures" / "command-hotkeys"
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


def _copy_trusted_host_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "trusted-host-access"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(TRUSTED_HOST_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_filter_pack_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "filter-pack"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(FILTER_PACK_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_command_hotkeys_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "command-hotkeys"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(COMMAND_HOTKEYS_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_matrix_rain_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "matrix-rain"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(MATRIX_RAIN_FIXTURE_ROOT, fixture)
    shutil.copytree(TEMPLATE_ROOT, workspace / "extension-template")
    shutil.copytree(SDK_ROOT, workspace / "packages" / "extension-sdk")
    return fixture


def _copy_grading_tools_fixture_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "author-workspace"
    fixture = workspace / "extension-fixtures" / "grading-tools"
    fixture.parent.mkdir(parents=True)
    shutil.copytree(GRADING_TOOLS_FIXTURE_ROOT, fixture)
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


def test_declarative_look_pack_scans_without_executable_entries(tmp_path: Path):
    extensions_root = tmp_path / "extensions"
    package_dir = extensions_root / "example.look-pack"
    shutil.copytree(LOOK_PACK_FIXTURE_ROOT, package_dir)
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(tmp_path / "state" / "approvals.json"),
    )

    item = manager.scan(force_digest=True)[0]

    assert item.status == "pending_approval"
    assert item.manifest is not None
    assert item.manifest.frontend is None
    assert item.manifest.backend is None
    assert [(lut.id, lut.path) for lut in item.lut_contributions] == [
        ("clean-warm", "luts/clean-warm.cube")
    ]


def test_command_hotkeys_fixture_builds_as_an_ordinary_trusted_extension(
    tmp_path: Path,
):
    fixture = _copy_command_hotkeys_fixture_workspace(tmp_path)
    _build_template(fixture)

    bundle = fixture / "frontend" / "dist" / "index.js"
    assert bundle.is_file()
    contents = bundle.read_bytes()
    assert b"bump-counter" in contents
    assert b"Mod+Alt+B" in contents
    assert b"timeline.clip.context" in contents


def test_filter_pack_fixture_builds_as_an_ordinary_trusted_extension(
    tmp_path: Path,
):
    fixture = _copy_filter_pack_fixture_workspace(tmp_path)
    _build_template(fixture)

    bundle = fixture / "frontend" / "dist" / "index.js"
    assert bundle.is_file()
    contents = bundle.read_bytes()
    assert b"trusted-filter" in contents
    assert b"example-filter-pack-desaturate" in contents


def test_matrix_rain_fixture_builds_as_an_ordinary_trusted_extension(
    tmp_path: Path,
):
    fixture = _copy_matrix_rain_fixture_workspace(tmp_path)
    _build_template(fixture)

    bundle = fixture / "frontend" / "dist" / "index.js"
    assert bundle.is_file()
    contents = bundle.read_bytes()
    # Registered through the ordinary trusted-filter lane with its own program,
    # declaring the history time-dependency and carrying no bundled Pixi copy.
    assert b"trusted-filter" in contents
    assert b"example-matrix-rain" in contents
    # History-dependent temporal feedback (Phase 3 ping-pong state).
    assert b"history" in contents
    # Both passes ship as WGSL structs: the glyph program and the state program.
    assert b"MatrixRainUniforms" in contents
    assert b"StateUniforms" in contents
    assert b"example-matrix-rain-state" in contents
    assert b"mainFragment" in contents


def test_matrix_rain_fixture_activates_with_matching_gl_and_wgsl_programs(
    tmp_path: Path,
):
    fixture = _copy_matrix_rain_fixture_workspace(tmp_path)
    _build_template(fixture)
    built_entry = fixture / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()

    # Drive activation with a mock host, capture the exact `Filter.from` options
    # for both the glyph and state passes, and construct each WGSL program
    # through the real Pixi `GpuProgram` factory to prove Pixi parses them (struct
    # + bind-group extraction), not merely that strings were supplied. The GLSL
    # programs can only be constructed against a live GL context, so headless we
    # assert their sources are present and defer real compilation to the GPU
    # visual suite. Also asserts the render sample's visual time reaches the time
    # uniform. Runs from the frontend workspace so `pixi.js` resolves.
    script = (
        f"const extension = await import({json.dumps(built_entry.as_uri())});"
        "const pixiReal = await import('pixi.js');"
        "const isGroup = (v) => v && typeof v === 'object' && !('style' in v)"
        "  && Object.values(v).length > 0"
        "  && Object.values(v).every((e) => e && typeof e === 'object' && 'value' in e);"
        "const options = [];"
        "const pixi = { Filter: { from(o) { options.push(o);"
        "  const resources = {};"
        "  for (const [k, v] of Object.entries(o.resources || {})) {"
        "    resources[k] = isGroup(v)"
        "      ? { uniforms: Object.fromEntries(Object.entries(v)"
        "          .map(([n, s]) => [n, s.value])) } : v; }"
        "  return { name: o.gl && o.gl.name, resources, destroy() {} }; } },"
        "  Texture: { WHITE: { source: { style: {} } } },"
        "  RenderTexture: { create: () => ("
        "    { source: { style: {}, width: 1, height: 1 }, destroy() {} }) } };"
        "let def;"
        "const api = {"
        "  timeline: { ticksPerSecond: 96000 },"
        "  runtime: { pixi },"
        "  transformations: { register(d) { def = d;"
        "    return { id: d.id, dispose() {} }; } },"
        "};"
        "await extension.activate({"
        "  extension: { id: 'example.matrix-rain', version: '1.0.0' },"
        "  sdkVersion: '1.7.0', signal: new AbortController().signal, api,"
        "  logger: { debug() {}, info() {}, warn() {}, error() {} },"
        "  onDispose() {} });"
        "if (!def || def.kind !== 'trusted-filter') throw new Error('registration');"
        "if (def.rendering.timeDependency !== 'history') throw new Error('rendering');"
        "const instance = def.createFilter();"
        "if (options.length !== 2) throw new Error('expected glyph + state filters');"
        "for (const o of options) {"
        "  if (!o.gl || !o.gl.vertex || !o.gl.fragment) throw new Error('missing gl');"
        "  if (o.clipToViewport !== false) throw new Error('clipToViewport');"
        "  const program = pixiReal.GpuProgram.from(o.gpu);"
        "  if (!program) throw new Error('gpu program construction failed'); }"
        # Glyph pass: reads its uniforms plus the state texture at group 1.
        "const glyph = pixiReal.GpuProgram.from(options[0].gpu).structsAndGroups;"
        "if (!glyph.structs.some((s) => s.name === 'MatrixRainUniforms'))"
        "  throw new Error('glyph struct not extracted');"
        "if (!glyph.groups.some((g) => g.group === 1 && g.binding === 1"
        "    && g.name === 'uState')) throw new Error('glyph uState binding missing');"
        # State pass: reads its uniforms plus the previous-state texture at group 1.
        "const st = pixiReal.GpuProgram.from(options[1].gpu).structsAndGroups;"
        "if (!st.structs.some((s) => s.name === 'StateUniforms'))"
        "  throw new Error('state struct not extracted');"
        "if (!st.groups.some((g) => g.group === 1 && g.binding === 1"
        "    && g.name === 'uPrevState')) throw new Error('uPrevState binding missing');"
        # The JS uniform-group key order must equal the WGSL struct member order,
        # or Pixi's UBO byte layout and the WGSL struct disagree on WebGPU.
        "const checkOrder = (opt, groupName, structName, sg) => {"
        "  const jsOrder = Object.keys(opt.resources[groupName]);"
        "  const struct = sg.structs.find((s) => s.name === structName);"
        "  const wgslOrder = Object.keys(struct.members);"
        "  if (JSON.stringify(jsOrder) !== JSON.stringify(wgslOrder))"
        "    throw new Error(structName + ' order mismatch: js=' + jsOrder"
        "      + ' wgsl=' + wgslOrder); };"
        "checkOrder(options[0], 'matrixRainUniforms', 'MatrixRainUniforms', glyph);"
        "checkOrder(options[1], 'stateUniforms', 'StateUniforms', st);"
        "const u = instance.object.resources.matrixRainUniforms.uniforms;"
        "if (!u || !Object.hasOwn(u, 'uTimeSeconds'))"
        "  throw new Error('missing uniforms');"
        "instance.update(def.defaultParameters, { target: {}, transformId: 't',"
        "  contentSize: { width: 1920, height: 1080 },"
        "  render: { sequenceId: 0, sampleId: 1, mode: 'preview',"
        "    continuity: 'sequential', presentationTimeTicks: 96000,"
        "    visualTimeTicks: 96000, sourceTimeTicks: 0, deltaTimeTicks: null,"
        "    fps: 30, isWarmup: false } });"
        "if (u.uTimeSeconds !== 1)"
        "  throw new Error('visual time not applied: ' + u.uTimeSeconds);"
        "console.log('matrix-rain dual-program smoke ok');"
    )
    smoke = _run_node(
        ["--input-type=module", "--eval", script],
        cwd=REPOSITORY_ROOT / "frontend",
    )
    _assert_command_succeeded(smoke)
    assert "matrix-rain dual-program smoke ok" in smoke.stdout


def test_grading_tools_fixture_builds_with_project_asset_ingestion(
    tmp_path: Path,
):
    fixture = _copy_grading_tools_fixture_workspace(tmp_path)
    _build_template(fixture)

    bundle = fixture / "frontend" / "dist" / "index.js"
    assert bundle.is_file()
    contents = bundle.read_bytes()
    assert b"grading-tools-identity.cube" in contents
    assert b"Attach project identity LUT" in contents


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


def test_trusted_host_fixture_builds_and_cleans_backend_hook_through_approval(
    tmp_path: Path,
):
    fixture = _copy_trusted_host_fixture_workspace(tmp_path)
    _build_template(fixture)
    built_entry = fixture / "frontend" / "dist" / "index.js"
    assert built_entry.is_file()
    bundle = built_entry.read_bytes()
    assert b"timeline.store" in bundle
    assert b"renderer.runtime" in bundle
    assert b"frontend/src" not in bundle

    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    shutil.copytree(fixture, extensions_root / "example.trusted-host-access")
    state_root = tmp_path / "state"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_root / "approvals.json"),
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
    assert pending.manifest is not None
    assert pending.manifest.vlo == ">=0.2.0 <0.3.0"
    assert pending.digest is not None
    assert {
        name for name in sys.modules if name.startswith("_vlo_extension_")
    } == extension_modules_before_scan

    backend_artifacts.stage(pending, pending.digest)
    manager.approve(pending.extension_id, pending.digest)
    extension_logger = logging.getLogger(
        "vlo.extensions.example.trusted-host-access"
    )
    original_filters = tuple(extension_logger.filters)
    app = FastAPI()

    summary = asyncio.run(runtime.start(app))

    assert summary.records[0].status == "active"
    assert len(extension_logger.filters) == len(original_filters) + 1
    version_route = next(
        route
        for route in app.routes
        if route.path
        == "/app/extensions/example.trusted-host-access/api/host-version"
    )
    assert version_route.endpoint()["vloVersion"] == "0.2.0"

    assert asyncio.run(runtime.stop()) == ()
    assert tuple(extension_logger.filters) == original_filters


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
