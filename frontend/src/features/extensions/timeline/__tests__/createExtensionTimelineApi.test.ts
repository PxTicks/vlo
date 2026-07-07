import { beforeEach, describe, expect, it } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionTimelineTransaction,
} from "../..";
import type {
  ClipTransform,
  ExtensionTimelineClip,
  MaskTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { createExtensionTimelineApi } from "../createExtensionTimelineApi";

function createScope(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

function createExtensionClip(
  id: string,
  extensionId: string,
): ExtensionTimelineClip {
  return {
    id,
    trackId: "track-visual",
    type: "extension",
    name: id,
    sourceDuration: null,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    extensionPayload: {
      extensionId,
      typeId: "shape",
      schemaVersion: 1,
      data: { points: 5 },
    },
  };
}

function createMaskClip(parentClipId: string): MaskTimelineClip {
  return {
    id: `${parentClipId}::mask::mask-1`,
    parentClipId,
    trackId: "track-visual",
    type: "mask",
    name: "Mask 1",
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [
      {
        id: "mask-position",
        type: "position",
        isEnabled: true,
        parameters: { x: 12, y: 8 },
      },
    ],
    maskType: "brush",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 200, baseHeight: 100 },
    brushMaskAssetId: "mask-asset-1",
    brushPaintedBounds: { x: 20, y: 30, width: 40, height: 50 },
    activeRange: { startSourceTicks: 10, endSourceTicks: 90 },
  };
}

describe("createExtensionTimelineApi", () => {
  beforeEach(() => {
    const shapeClip = createExtensionClip("shape-1", "example.shapes");
    shapeClip.components = [
      {
        id: "mask-ref-1",
        type: "mask_ref",
        parameters: { maskClipId: "shape-1::mask::mask-1" },
      },
    ];
    const tracks: TimelineTrack[] = [
      {
        id: "track-visual",
        label: "Visual",
        type: "visual",
        isVisible: true,
        isLocked: false,
        isMuted: false,
      },
    ];
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks,
      clips: [
        shapeClip,
        createExtensionClip("tracker-1", "example.tracker"),
        createMaskClip("shape-1"),
      ],
      transitions: [],
    });
    useTimelineStore.getState().setTimelinePersistenceSuspended(true);
  });

  it("creates an extension entity that round-trips through undo and redo", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));
    expect(api.ticksPerSecond).toBe(96_000);
    let entityId = "";

    const result = api.transaction("Create star", (transaction) => {
      entityId = transaction.createEntity({
        name: "Seven-point star",
        startTicks: 12,
        durationTicks: 48,
        payload: {
          extensionId: "example.shapes",
          typeId: "shape",
          schemaVersion: 1,
          data: { points: 7 },
        },
      });
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      label: "Create star",
    });
    expect(entityId).toMatch(/^extension_/);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === entityId),
    ).toMatchObject({
      type: "extension",
      name: "Seven-point star",
      start: 12,
      timelineDuration: 48,
      sourceDuration: null,
      transformations: [],
      extensionPayload: {
        extensionId: "example.shapes",
        typeId: "shape",
        data: { points: 7 },
      },
    });
    expect(api.listEntities().map((entity) => entity.id)).toContain(entityId);

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.some((clip) => clip.id === entityId),
    ).toBe(false);

    expect(useTimelineStore.getState().redo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.some((clip) => clip.id === entityId),
    ).toBe(true);
  });

  it("commits a labelled atomic mutation through undo and redo", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));

    expect(api.listEntities().map((entity) => entity.id)).toEqual(["shape-1"]);
    const result = api.transaction("Refine star", (transaction) => {
      transaction.updatePayload("shape-1", {
        extensionId: "example.shapes",
        typeId: "shape",
        schemaVersion: 2,
        data: { points: 7 },
      });
      transaction.moveEntity("shape-1", { startTicks: 25 });
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      label: "Refine star",
    });
    expect(useTimelineStore.getState().undoLabel).toBe("Refine star");
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({
      start: 25,
      extensionPayload: { schemaVersion: 2, data: { points: 7 } },
    });

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({
      start: 0,
      extensionPayload: { schemaVersion: 1, data: { points: 5 } },
    });
    expect(useTimelineStore.getState().redoLabel).toBe("Refine star");

    expect(useTimelineStore.getState().redo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({
      start: 25,
      extensionPayload: { schemaVersion: 2, data: { points: 7 } },
    });
  });

  it("rejects cross-owner mutations without committing partial commands", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));
    const result = api.transaction("Bad batch", (transaction) => {
      transaction.moveEntity("shape-1", { startTicks: 50 });
      transaction.removeEntity("tracker-1");
    });

    expect(result).toMatchObject({ ok: false, code: "wrong_owner" });
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({ start: 0 });
    expect(useTimelineStore.getState().undoLabel).toBeNull();
  });

  it("rejects creation on behalf of another extension", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));
    const result = api.transaction("Spoof owner", (transaction) => {
      transaction.createEntity({
        name: "Spoofed",
        startTicks: 0,
        durationTicks: 10,
        payload: {
          extensionId: "example.tracker",
          typeId: "shape",
          schemaVersion: 1,
          data: {},
        },
      });
    });

    expect(result).toMatchObject({ ok: false, code: "wrong_owner" });
    expect(
      useTimelineStore.getState().clips.some((clip) => clip.name === "Spoofed"),
    ).toBe(false);
  });

  it("closes transaction objects after synchronous callbacks", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));
    let captured: ExtensionTimelineTransaction | undefined;
    const result = api.transaction("No changes", (transaction) => {
      captured = transaction;
    });

    expect(result).toEqual({
      ok: true,
      changed: false,
      label: "No changes",
    });
    expect(() => captured?.removeEntity("shape-1")).toThrow(/already closed/);
    expect(
      api.transaction("Async transaction", async () => undefined),
    ).toMatchObject({ ok: false, code: "invalid_command" });
  });

  it("commits a tracking transform to an ordinary clip in one undo entry", () => {
    const api = createExtensionTimelineApi(createScope("example.tracker"));
    const result = api.transaction("Apply tracking result", (transaction) => {
      transaction.upsertTransform("shape-1", {
        id: "tracked-position",
        type: "position",
        parameters: {
          x: 0,
          y: 0,
          extensionPath: {
            type: "extension-path2d",
            geometry: {
              extensionId: "example.tracker",
              typeId: "tracking-path",
              schemaVersion: 1,
              data: { points: [{ x: 0, y: 0 }, { x: 10, y: 5 }] },
            },
            timing: 0.5,
          },
        },
      });
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      label: "Apply tracking result",
    });
    expect(useTimelineStore.getState().undoLabel).toBe("Apply tracking result");
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1")
        ?.transformations,
    ).toEqual([
      expect.objectContaining({
        id: "tracked-position",
        type: "position",
      }),
    ]);
    expect(api.listClips().find((clip) => clip.id === "shape-1")).toMatchObject({
      durationTicks: 100,
      transformations: [{ id: "tracked-position" }],
    });

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1")
      ?.transformations,
    ).toEqual([]);
  });

  it("inserts extension-created default transforms before dynamic transforms", () => {
    const shape = createExtensionClip("shape-with-filter", "example.shapes");
    shape.transformations = [
      {
        id: "filter-1",
        type: "filter",
        filterName: "HslAdjustmentFilter",
        isEnabled: true,
        parameters: { hue: 0 },
      } as ClipTransform & { filterName: string },
    ];
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track-visual",
          label: "Visual",
          type: "visual",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [shape],
      transitions: [],
    });

    const api = createExtensionTimelineApi(createScope("example.tracker"));
    const result = api.transaction("Apply tracking result", (transaction) => {
      transaction.upsertTransform("shape-with-filter", {
        id: "tracked-position",
        type: "position",
        parameters: { x: 0, y: 0 },
      });
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      useTimelineStore
        .getState()
        .clips.find((clip) => clip.id === "shape-with-filter")
        ?.transformations.map((transform) => transform.type),
    ).toEqual(["position", "filter"]);
  });

  it("lists detached mask snapshots for a clip", () => {
    const api = createExtensionTimelineApi(createScope("example.tracker"));

    expect(api.listClipMasks("shape-1")).toEqual([
      expect.objectContaining({
        id: "shape-1::mask::mask-1",
        parentClipId: "shape-1",
        localId: "mask-1",
        startTicks: 0,
        durationTicks: 100,
        maskType: "brush",
        maskMode: "apply",
        maskInverted: false,
        parameters: { baseWidth: 200, baseHeight: 100 },
        assetId: "mask-asset-1",
        paintedBounds: { x: 20, y: 30, width: 40, height: 50 },
        activeRange: { startSourceTicks: 10, endSourceTicks: 90 },
        transformations: [
          expect.objectContaining({
            id: "mask-position",
            type: "position",
            parameters: { x: 12, y: 8 },
          }),
        ],
      }),
    ]);
  });

  it("maps source frames and pixels into canonical timeline/project domains", () => {
    const api = createExtensionTimelineApi(createScope("example.tracker"));
    const project = api.getProject();

    expect(project).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(api.sourceFrameToTicks(15, 30)).toBe(48_000);
    expect(api.clipProgressToSourceTicks("shape-1", 0.5)).toBe(50);
    expect(api.sourceTicksToClipProgress("shape-1", 75)).toBe(0.75);
    expect(
      api.sourcePointToProject(
        { x: 1280, y: 360 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 960, y: 0 });
    expect(() => api.sourceFrameToTicks(-1, 30)).toThrow(/non-negative/);
  });
});
