import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionBackendJobSnapshot,
  ExtensionContext,
  ExtensionSpatialPathDefinition,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineTransformInput,
  ExtensionTrustedUiComponentDefinition,
  JsonValue,
  VloExtensionApi,
} from "../../types";
import {
  activate,
  commitTrackingResult,
  createTrackingPath,
  runTrackingJob,
  type TrackingResult,
} from "../../../../../../extension-fixtures/tracking/frontend/src/index";
import { extensionColorApi } from "../../services/extensionColorApi";
import { createExtensionTimelineTransactionStub } from "../../../../testUtils/extensionTimeline";
import { createExtensionClipSnapshot } from "../../../../testUtils/extensionTimeline";

const clip: ExtensionTimelineClipSnapshot = createExtensionClipSnapshot({
  name: "Source clip",
  assetId: "asset-1",
});

const trackingResult: TrackingResult = {
  schemaVersion: 1,
  coordinateSpace: "source-pixels",
  sourceDimensions: { width: 1920, height: 1080 },
  timebase: { kind: "frames", fps: 30 },
  sourceWindow: { startTicks: 0, endTicks: 96_000 },
  target: { id: "face-1", label: "Face" },
  samples: [
    { frameIndex: 0, x: 960, y: 540, confidence: 0.95 },
    { frameIndex: 30, x: 1440, y: 810, confidence: 0.9 },
  ],
  artifactId: "b".repeat(32),
};

function completedJob(): ExtensionBackendJobSnapshot {
  return {
    jobId: "job-1",
    jobType: "track",
    extensionId: "example.tracking",
    extensionVersion: "1.0.0",
    status: "succeeded",
    progress: 1,
    message: "Completed",
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 2,
    result: JSON.parse(JSON.stringify(trackingResult)) as JsonValue,
    artifacts: [
      {
        artifactId: trackingResult.artifactId,
        role: "output",
        filename: "tracking-result.json",
        contentType: "application/json",
        size: 10,
        sha256: "c".repeat(64),
      },
    ],
    diagnostics: [],
  };
}

function createConformanceApi() {
  let spatialPathDefinition: ExtensionSpatialPathDefinition | undefined;
  let uiDefinition: ExtensionTrustedUiComponentDefinition | undefined;
  let committedTransform: ExtensionTimelineTransformInput | undefined;
  let transactionCount = 0;
  const uploadArtifact = vi.fn(async () => ({
    artifactId: "a".repeat(32),
    role: "input" as const,
    filename: "source.mp4",
    contentType: "video/mp4",
    size: 6,
    sha256: "d".repeat(64),
  }));
  const submitJob = vi.fn(async () => ({
    ...completedJob(),
    status: "queued" as const,
    progress: 0,
    result: undefined,
    artifacts: [],
  }));
  const waitForJob = vi.fn(async () => completedJob());
  const getArtifact = vi.fn(async () => {
    const { artifactId: _artifactId, ...persisted } = trackingResult;
    const content = JSON.stringify(persisted);
    return Object.assign(new Blob([content], { type: "application/json" }), {
      text: async () => content,
    });
  });
  const readBlob = vi.fn(async () => new Blob(["source"], { type: "video/mp4" }));

  const api: VloExtensionApi = {
    extensions: {
      listDependencies: () => [],
      getApi: () => undefined,
      requireApi: () => {
        throw new Error("no peer API");
      },
    },
    trusted: {
      host: {
        hostVersion: "0.2.0",
        list: () => [],
        get: () => undefined,
        require: () => {
          throw new Error("unavailable");
        },
        getRevision: () => 0,
        subscribe: () => () => undefined,
        patchProperty: () => ({ dispose: () => undefined }),
      },
    },
    runtime: {
      pixi: {} as VloExtensionApi["runtime"]["pixi"],
      react: { createElement: () => ({}) },
      mui: {},
      panelUi: {},
    },
    color: extensionColorApi,
    backend: {
      call: async () => new Response(),
      listJobs: async () => [
        {
          id: "track",
          label: "Track fixture target",
          timeoutSeconds: 30,
          readiness: { ready: true, message: "Ready" },
        },
      ],
      uploadArtifact,
      submitJob,
      getJob: async () => completedJob(),
      cancelJob: async () => ({ ...completedJob(), status: "cancelled" }),
      waitForJob,
      getArtifact,
      getArtifactUrl: (artifactId) => `/artifact/${artifactId}`,
    },
    assets: {
      list: () => [],
      get: () => ({
        id: "asset-1",
        hash: "asset-hash",
        name: "source.mp4",
        type: "video",
        src: "source.mp4",
        fps: 30,
      }),
      readBlob,
      ingest: async () => {
        throw new Error("Asset ingest is not used by this fixture.");
      },
      subscribe: () => () => undefined,
      getRevision: () => 0,
    },
    storage: {
      local: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        keys: async () => [],
        subscribe: () => () => undefined,
        getRevision: () => 0,
      },
      project: null,
    },
    generation: {
      listInputs: () => [],
      getSession: () => null,
      getRevision: () => 0,
      subscribe: () => () => undefined,
      transaction: (label) => ({ ok: true, changed: false, label }),
    },
    animation: {
      scalarSources: {
        register: (definition) => ({ id: definition.id, dispose: () => undefined }),
      },
      interpolations: {
        register: (definition) => ({ id: definition.id, dispose: () => undefined }),
      },
      spatialPaths: {
        register: (definition) => {
          spatialPathDefinition = definition;
          return { id: definition.id, dispose: () => undefined };
        },
      },
    },
    payloadProviders: {
      register: (definition) => ({ id: definition.id, dispose: () => undefined }),
    },
    entityProviders: {
      register: (definition) => ({ id: definition.id, dispose: () => undefined }),
    },
    playback: {
      getTime: () => 0,
      getFrameTime: () => 0,
      isPlaying: () => false,
      seek: () => ({ ok: true, changed: false }),
      play: () => ({ ok: true, changed: false }),
      pause: () => ({ ok: true, changed: false }),
      subscribe: () => () => undefined,
    },
    selection: {
      get: () => ({ clipIds: [], transitionId: null }),
      setClips: () => ({ ok: true, changed: false }),
      setTransition: () => ({ ok: true, changed: false }),
      subscribe: () => () => undefined,
      getRevision: () => 0,
    },
    project: {
      get: () => null,
      subscribe: () => () => undefined,
      getRevision: () => 0,
      onBeforeSave: () => () => undefined,
    },
    audio: {
      listClips: () => [],
      getClip: () => undefined,
      listTracks: () => [],
      subscribe: () => () => undefined,
      getRevision: () => 0,
      inspect: async () => ({
        ok: false,
        code: "asset_not_found",
        message: "stub",
      }),
      readPcm: async () => ({
        ok: false,
        code: "asset_not_found",
        message: "stub",
      }),
      readWaveform: async () => ({
        ok: false,
        code: "asset_not_found",
        message: "stub",
      }),
    },
    export: {
      getRun: () => null,
      listRuns: () => [],
      subscribe: () => () => undefined,
      getRevision: () => 0,
      renderFrame: async () => ({
        ok: false,
        code: "no_renderer",
        message: "stub",
      }),
      start: () => ({ ok: false, code: "no_renderer", message: "stub" }),
      cancel: () => ({ ok: false, code: "no_renderer", message: "stub" }),
    },
    timeline: {
      subscribe: () => () => undefined,
      getRevision: () => 0,
      ticksPerSecond: 96_000,
      listEntities: () => [],
      listClips: () => [clip],
      listTracks: () => [],
      listTransitions: () => [],
      listClipMasks: () => [],
      getProject: () => ({
        width: 1920,
        height: 1080,
        fps: 30,
        fitMode: "cover",
      }),
      sourceFrameToTicks: (frameIndex, fps) =>
        Math.round((frameIndex * 96_000) / fps),
      clipProgressToSourceTicks: (_clipId, progress) => progress * 96_000,
      sourceTicksToClipProgress: (_clipId, sourceTicks) => sourceTicks / 96_000,
      sourcePointToProject: (point, source) => ({
        x: point.x - source.width / 2,
        y: point.y - source.height / 2,
      }),
      transaction: (label, callback) => {
        transactionCount += 1;
        const transaction = createExtensionTimelineTransactionStub({
          upsertTransform: (_clipId, transform) => {
            committedTransform = transform;
            return transform.id ?? "generated";
          },
        });
        callback(transaction);
        return { ok: true, changed: true, label };
      },
      registerClipOverlay: (definition) => ({
        id: definition.id,
        dispose: () => undefined,
      }),
    },
    transformations: {
      register: (definition) => ({ id: definition.id, dispose: () => undefined }),
      presets: {
        register: (definition) => ({
          id: definition.id,
          dispose: () => undefined,
        }),
      },
    },
    transitions: {
      register: (definition) => ({ id: definition.id, dispose: () => undefined }),
    },
    ui: {
      notifications: {
        toast: () => ({ id: "toast", dispose: () => undefined }),
        task: () => ({
          id: "task",
          update: () => undefined,
          settle: () => undefined,
          dispose: () => undefined,
        }),
      },
      scopes: {
        register: (definition) => ({
          id: definition.id,
          dispose: () => undefined,
        }),
      },
      registerPanelControl: (definition) => ({
        id: definition.id,
        dispose: () => undefined,
      }),
      registerNotice: (definition) => ({ id: definition.id, dispose: () => undefined }),
      registerComponent: (definition) => {
        uiDefinition = definition;
        return { id: definition.id, dispose: () => undefined };
      },
      registerModal: (definition) => ({
        id: definition.id,
        dispose: () => undefined,
      }),
      registerView: (definition) => ({
        id: definition.id,
        dispose: () => undefined,
      }),
      openModal: async () => undefined,
      openView: () => false,
      menus: {
        addItem: (definition) => ({
          id: definition.id,
          dispose: () => undefined,
        }),
        listMenus: () => [],
      },
      catalogues: {
        addOption: (option) => ({
          id: option.id,
          dispose: () => undefined,
        }),
        list: () => [],
        listCatalogues: () => [],
        subscribe: () => () => undefined,
        getRevision: () => 0,
      },
      canvasTools: {
        register: (definition) => ({
          id: definition.id,
          command: `canvas-tool.${definition.id}`,
          dispose: () => undefined,
        }),
      },
      commands: {
        register: (definition) => ({
          id: definition.id,
          dispose: () => undefined,
        }),
        registerKeybinding: (request) => ({
          id: request.id,
          dispose: () => undefined,
        }),
        execute: async () => true,
        getContextKey: () => undefined,
        setContextKey: (key: string) => `extension.example.tracking.${key}`,
        subscribeContextKeys: () => () => undefined,
      },
    },
  };
  return {
    api,
    uploadArtifact,
    submitJob,
    waitForJob,
    getArtifact,
    readBlob,
    getSpatialPathDefinition: () => spatialPathDefinition,
    getUiDefinition: () => uiDefinition,
    getCommittedTransform: () => committedTransform,
    getTransactionCount: () => transactionCount,
  };
}

describe("tracking extension conformance fixture", () => {
  it("composes source upload, job progress, artifact validation, preview, and commit", async () => {
    const fixture = createConformanceApi();
    const context: ExtensionContext = {
      extension: { id: "example.tracking", version: "1.0.0" },
      sdkVersion: "1.0.0",
      signal: new AbortController().signal,
      api: fixture.api,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onDispose: () => undefined,
      exportApi: vi.fn(),
    };
    await activate(context);

    const result = await runTrackingJob(fixture.api, clip);
    expect(fixture.readBlob).toHaveBeenCalledWith("asset-1");
    expect(fixture.uploadArtifact).toHaveBeenCalledOnce();
    expect(fixture.submitJob).toHaveBeenCalledWith(
      "track",
      expect.objectContaining({
        source: expect.objectContaining({ ticksPerSecond: 96_000 }),
      }),
      ["a".repeat(32)],
    );
    expect(fixture.waitForJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ onProgress: undefined }),
    );
    expect(fixture.getArtifact).toHaveBeenCalledWith(trackingResult.artifactId);

    const preview = createTrackingPath(fixture.api.timeline, clip.id, result);
    expect(fixture.getTransactionCount()).toBe(0);
    expect(preview.geometry.data).toMatchObject({
      points: [
        expect.objectContaining({ progress: 0, x: 0, y: 0 }),
        expect.objectContaining({ progress: 1, x: 480, y: 270 }),
      ],
    });
    const provider = fixture.getSpatialPathDefinition();
    expect(provider).toBeDefined();
    const compiled = provider?.compile(preview.geometry.data, 1);
    expect(compiled?.pointAt(0.5)).toEqual({ x: 240, y: 135 });

    expect(commitTrackingResult(fixture.api.timeline, clip.id, result)).toEqual({
      ok: true,
      changed: true,
      label: "Apply tracking path",
    });
    expect(fixture.getTransactionCount()).toBe(1);
    expect(fixture.getCommittedTransform()).toMatchObject({
      type: "position",
      parameters: { extensionPath: { type: "extension-path2d" } },
    });
    expect(fixture.getUiDefinition()).toMatchObject({
      id: "tracking-panel",
      kind: "trusted-react",
    });
  });
});
