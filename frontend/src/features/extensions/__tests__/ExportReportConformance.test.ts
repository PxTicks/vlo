import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The renderer front door boots Pixi at import time, and this fixture only
// needs the one frame-capture entry point from it.
vi.mock("../../renderer", () => ({
  renderProjectFrameAtTick: vi.fn(),
}));

import type {
  ExtensionApiScope,
  ExtensionResource,
  JsonValue,
  VloExtensionApi,
} from "../types";
import {
  activate,
  EXPORT_REPORT_STORAGE_KEY,
  getExportReportForConformance,
  lastPlacedTick,
  resetExportReportForConformance,
} from "../../../../../extension-fixtures/export-report/frontend/src/index";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import {
  installHostExportController,
  type HostExportRunRequest,
} from "../../../core/export/exportController";
import {
  beginExportRun,
  resetExportRunLogForTests,
  type ExportRunHandle,
} from "../../../core/export/exportRunLog";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { declareExportFormats } from "../../player/exportFormatsCatalogue";
import { renderProjectFrameAtTick } from "../../renderer";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useProjectStore } from "../../project";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { createExtensionCommandApi } from "../commands/CommandRegistry";
import { createExtensionExportApi } from "../export/createExtensionExportApi";
import { createExtensionPlaybackApi } from "../playback/createExtensionPlaybackApi";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";

const OWNER_ID = "example.export-report";
const TICKS_PER_SECOND = 96_000;

declareExportFormats();

function videoClip(
  id: string,
  start: number,
  duration: number,
): TimelineClip {
  return {
    id,
    trackId: "track-visual",
    type: "video",
    name: id,
    assetId: "asset-1",
    src: "asset-1.mp4",
    sourceDuration: duration,
    start,
    timelineDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    transformations: [],
  } as unknown as TimelineClip;
}

const TRACKS: TimelineTrack[] = [
  {
    id: "track-visual",
    label: "Visual",
    type: "visual",
    isVisible: true,
    isLocked: false,
    isMuted: false,
  },
];

/**
 * Stands in for the mounted editor, which cannot render in a unit test. It
 * drives the real run log — the contract under test is that a run started
 * through the registry is observable exactly like one the user started, so
 * the log must be genuine even when the renderer is not.
 */
function installTestExporter(options: { available?: boolean } = {}) {
  const state: {
    requests: HostExportRunRequest[];
    run: ExportRunHandle | null;
    cancels: number;
  } = { requests: [], run: null, cancels: 0 };

  const uninstall = installHostExportController({
    canStart: () => options.available !== false,
    startRange: (request) => {
      state.requests.push(request);
      const run = beginExportRun({
        kind: "range",
        startTicks: request.startTicks,
        endTicks: request.endTicks,
        formatId: request.formatId,
        ...(request.startedByExtension
          ? { startedByExtension: request.startedByExtension }
          : {}),
      });
      state.run = run;
      return run.id;
    },
    cancel: () => {
      state.cancels += 1;
      state.run?.cancel();
    },
  });

  return { state, uninstall };
}

interface Harness {
  api: VloExtensionApi;
  scope: ExtensionApiScope;
  resources: ExtensionResource[];
  projectValues: Map<string, JsonValue>;
  ingested: { name: string; type: string }[];
  dispose: () => Promise<void>;
}

function createHarness(): Harness {
  const contextKeys = new HostContextKeyService();
  const commandTable = new HostCommandTable(contextKeys);
  const keybindings = new HostKeybindingRegistry(() => false);
  contextKeys.set("project.open", true);

  const resources: ExtensionResource[] = [];
  const scope: ExtensionApiScope = {
    extension: { id: OWNER_ID, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };

  const projectValues = new Map<string, JsonValue>();
  const projectStore = {
    get: async (key: string) => projectValues.get(key),
    set: async (key: string, value: JsonValue) => {
      projectValues.set(key, structuredClone(value));
    },
    delete: async (key: string) => void projectValues.delete(key),
    keys: async () => [...projectValues.keys()],
    subscribe: () => () => undefined,
    getRevision: () => projectValues.size,
  };

  const ingested: { name: string; type: string }[] = [];
  const api = {
    timeline: createExtensionTimelineApi(scope),
    playback: createExtensionPlaybackApi(scope),
    export: createExtensionExportApi(scope),
    assets: {
      ingest: async (input: { name: string; type: string }) => {
        ingested.push({ name: input.name, type: input.type });
        return { id: "asset-thumbnail" };
      },
    },
    storage: { local: projectStore, project: projectStore },
    ui: {
      commands: createExtensionCommandApi(
        scope,
        commandTable,
        keybindings,
        contextKeys,
      ),
    },
  } as unknown as VloExtensionApi;

  return {
    api,
    scope,
    resources,
    projectValues,
    ingested,
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
  };
}

function activateFixture(harness: Harness) {
  const disposers: ExtensionResource[] = [];
  activate({
    extension: { id: OWNER_ID, version: "1.0.0" },
    sdkVersion: "1.11.0",
    signal: harness.scope.signal,
    api: harness.api,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (resource) => disposers.push(resource),
    exportApi: vi.fn(),
  });
  return disposers;
}

function seedProject() {
  useTimelineStore.setState({
    tracks: TRACKS,
    clips: [
      videoClip("clip-a", 0, TICKS_PER_SECOND),
      videoClip("clip-b", TICKS_PER_SECOND, TICKS_PER_SECOND),
    ],
    transitions: [],
    selectedClipIds: [],
    selectedTransitionId: null,
  });
  useProjectStore.setState({
    project: {
      id: "project-1",
      title: "Fixture project",
      rootAssetsFolder: "assets",
      createdAt: 10,
      lastModified: 20,
    },
    rootHandle: {} as FileSystemDirectoryHandle,
  });
}

beforeEach(() => {
  resetExportRunLogForTests();
  resetExportReportForConformance();
  useExtractStore.setState({ isProcessing: false });
  seedProject();
});

afterEach(() => {
  useProjectStore.setState({ project: null, rootHandle: null });
  vi.mocked(renderProjectFrameAtTick).mockReset();
});

describe("export report conformance fixture", () => {
  it("derives the rendered range from placed clips only", () => {
    expect(
      lastPlacedTick([
        { type: "video", startTicks: 0, durationTicks: 100 },
        { type: "mask", startTicks: 0, durationTicks: 9_000 },
        { type: "video", startTicks: 100, durationTicks: 60 },
      ]),
    ).toBe(160);
    expect(lastPlacedTick([])).toBeNull();
  });

  it("starts a render through the host registry and reports what began", async () => {
    const harness = createHarness();
    const disposers = activateFixture(harness);
    const exporter = installTestExporter();

    expect(
      await harness.api.ui.commands.execute("render-placed-range"),
    ).toBe(true);

    expect(exporter.state.requests).toEqual([
      {
        startTicks: 0,
        endTicks: 2 * TICKS_PER_SECOND,
        formatId: "mp4",
        format: "mp4",
        startedByExtension: OWNER_ID,
      },
    ]);
    expect(getExportReportForConformance().lastStart).toMatchObject({
      ok: true,
      run: { status: "running", kind: "range", startedByExtension: OWNER_ID },
    });
    // A run that has not settled is not in the report yet.
    expect(getExportReportForConformance().entries).toEqual([]);

    exporter.uninstall();
    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("records each run once it settles, exactly once, and persists the report", async () => {
    const harness = createHarness();
    const disposers = activateFixture(harness);
    const exporter = installTestExporter();

    await harness.api.ui.commands.execute("render-placed-range");
    // Progress is not commit-grained: it fires repeatedly, and none of it may
    // reach the report.
    exporter.state.run?.reportProgress(25);
    exporter.state.run?.reportProgress(80);
    expect(getExportReportForConformance().entries).toEqual([]);

    exporter.state.run?.complete({ assetId: "asset-render" });
    // A settled run cannot be recorded twice, however many times it signals.
    exporter.state.run?.reportProgress(100);

    expect(getExportReportForConformance().entries).toEqual([
      {
        runId: expect.any(String),
        kind: "range",
        status: "completed",
        ours: true,
        durationMs: expect.any(Number),
        assetId: "asset-render",
        error: null,
      },
    ]);

    await Promise.resolve();
    expect(harness.projectValues.get(EXPORT_REPORT_STORAGE_KEY)).toMatchObject([
      { status: "completed", assetId: "asset-render" },
    ]);

    exporter.uninstall();
    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("reports the user's renders too, marked as not its own", async () => {
    const harness = createHarness();
    const disposers = activateFixture(harness);

    const userRun = beginExportRun({
      kind: "project",
      startTicks: 0,
      endTicks: 2 * TICKS_PER_SECOND,
      formatId: "webm",
    });
    userRun.fail(new Error("Encoder gave up"));

    expect(getExportReportForConformance().entries).toEqual([
      {
        runId: userRun.id,
        kind: "project",
        status: "failed",
        ours: false,
        durationMs: expect.any(Number),
        assetId: null,
        error: "Encoder gave up",
      },
    ]);

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("refuses a start the editor cannot take", async () => {
    const harness = createHarness();
    const { api } = harness;

    // No renderer mounted at all — the projects page, or a booting editor.
    expect(api.export.start()).toMatchObject({ ok: false, code: "no_renderer" });

    const exporter = installTestExporter();
    expect(api.export.start({ formatId: "gif" })).toMatchObject({
      ok: false,
      code: "unknown_format",
    });
    expect(
      api.export.start({ startTicks: 0, endTicks: 99 * TICKS_PER_SECOND }),
    ).toMatchObject({ ok: false, code: "invalid_range" });
    expect(
      api.export.start({ startTicks: TICKS_PER_SECOND, endTicks: 0 }),
    ).toMatchObject({ ok: false, code: "invalid_range" });

    // Renders are exclusive: one in flight refuses the next rather than
    // queueing it.
    expect(api.export.start()).toMatchObject({ ok: true });
    expect(api.export.start()).toMatchObject({ ok: false, code: "export_busy" });
    exporter.state.run?.complete({ assetId: "asset-render" });

    useProjectStore.setState({ project: null, rootHandle: null });
    expect(api.export.start()).toMatchObject({ ok: false, code: "no_project" });

    expect(() => api.export.start({ startTicks: Number.NaN })).toThrow(TypeError);

    exporter.uninstall();
    await harness.dispose();
  });

  it("cancels only the runs it started", async () => {
    const harness = createHarness();
    const { api } = harness;
    const exporter = installTestExporter();

    expect(api.export.cancel("export-run-404")).toMatchObject({
      ok: false,
      code: "run_not_found",
    });

    const started = api.export.start();
    expect(started.ok).toBe(true);
    const runId = started.ok ? started.run.id : "";

    expect(api.export.cancel(runId)).toEqual({ ok: true, changed: true });
    expect(exporter.state.cancels).toBe(1);
    // Cancelling a settled run is an ordinary answer, not a failure.
    expect(api.export.cancel(runId)).toEqual({ ok: true, changed: false });
    expect(api.export.getRun()).toMatchObject({ status: "cancelled" });

    const foreignRun = beginExportRun({
      kind: "project",
      startTicks: 0,
      endTicks: 10,
    });
    expect(api.export.cancel(foreignRun.id)).toMatchObject({
      ok: false,
      code: "run_not_owned",
    });

    exporter.uninstall();
    await harness.dispose();
  });

  it("captures a composited frame and ingests it", async () => {
    vi.mocked(renderProjectFrameAtTick).mockResolvedValue({
      blob: new Blob(["png"], { type: "image/png" }),
      width: 1920,
      height: 1080,
    });
    playbackClock.setTime(TICKS_PER_SECOND);

    const harness = createHarness();
    const disposers = activateFixture(harness);

    expect(await harness.api.ui.commands.execute("capture-thumbnail")).toBe(
      true,
    );

    expect(renderProjectFrameAtTick).toHaveBeenCalledWith(
      TICKS_PER_SECOND,
      expect.objectContaining({ mimeType: "image/png" }),
    );
    expect(getExportReportForConformance().lastFrame).toMatchObject({
      ok: true,
      width: 1920,
      height: 1080,
      timeTicks: TICKS_PER_SECOND,
    });
    expect(harness.ingested).toEqual([
      { name: `thumbnail-${TICKS_PER_SECOND}.png`, type: "image" },
    ]);
    expect(getExportReportForConformance().thumbnailAssetId).toBe(
      "asset-thumbnail",
    );

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("signals again when the renderer frees up, not only when a run settles", async () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.api.export.subscribe(listener);

    // A host flow that has not reached the renderer yet still refuses a start,
    // and it leaves no run behind to signal when it ends — so availability
    // itself has to move the revision, or `export_busy` would be the last
    // thing an extension ever heard.
    const before = harness.api.export.getRevision();
    useExtractStore.setState({ isProcessing: true });
    const exporter = installTestExporter();
    expect(harness.api.export.start()).toMatchObject({
      ok: false,
      code: "export_busy",
    });

    useExtractStore.setState({ isProcessing: false });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(harness.api.export.getRevision()).toBeGreaterThan(before);
    expect(harness.api.export.start()).toMatchObject({ ok: true });

    exporter.state.run?.complete();
    exporter.uninstall();
    await harness.dispose();
  });

  it("refuses a second frame render while one is compositing", async () => {
    let release!: (frame: {
      blob: Blob;
      width: number;
      height: number;
    }) => void;
    vi.mocked(renderProjectFrameAtTick).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const harness = createHarness();
    const first = harness.api.export.renderFrame(0);

    await expect(harness.api.export.renderFrame(0)).resolves.toMatchObject({
      ok: false,
      code: "export_busy",
    });
    // A frame render holds the decoders, so it also blocks a full render.
    const exporter = installTestExporter();
    expect(harness.api.export.start()).toMatchObject({
      ok: false,
      code: "export_busy",
    });

    release({ blob: new Blob(["png"]), width: 16, height: 9 });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(renderProjectFrameAtTick).toHaveBeenCalledTimes(1);

    exporter.uninstall();
    await harness.dispose();
  });

  it("refuses a frame render while a render owns the decoders", async () => {
    const harness = createHarness();
    const exporter = installTestExporter();
    harness.api.export.start();

    await expect(harness.api.export.renderFrame(0)).resolves.toMatchObject({
      ok: false,
      code: "export_busy",
    });
    expect(renderProjectFrameAtTick).not.toHaveBeenCalled();

    exporter.state.run?.complete();
    exporter.uninstall();
    await harness.dispose();
  });
});
