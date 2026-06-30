import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionBackendJobSnapshot,
  ExtensionContext,
  ExtensionSpatialPathDefinition,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineTransformInput,
  ExtensionTimelineTransaction,
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

const clip: ExtensionTimelineClipSnapshot = {
  id: "clip-1",
  type: "video",
  name: "Source clip",
  trackId: "track-1",
  startTicks: 0,
  durationTicks: 96_000,
  assetId: "asset-1",
  transformations: [],
};

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
    runtime: {
      pixi: {} as VloExtensionApi["runtime"]["pixi"],
      react: { createElement: () => ({}) },
    },
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
    timeline: {
      ticksPerSecond: 96_000,
      listEntities: () => [],
      listClips: () => [clip],
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
        const transaction: ExtensionTimelineTransaction = {
          createEntity: () => "unused",
          updatePayload: () => undefined,
          moveEntity: () => undefined,
          removeEntity: () => undefined,
          upsertTransform: (_clipId, transform) => {
            committedTransform = transform;
            return transform.id ?? "generated";
          },
          removeTransform: () => undefined,
        };
        callback(transaction);
        return { ok: true, changed: true, label };
      },
    },
    transformations: {
      register: (definition) => ({ id: definition.id, dispose: () => undefined }),
    },
    ui: {
      registerNotice: (definition) => ({ id: definition.id, dispose: () => undefined }),
      registerComponent: (definition) => {
        uiDefinition = definition;
        return { id: definition.id, dispose: () => undefined };
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
