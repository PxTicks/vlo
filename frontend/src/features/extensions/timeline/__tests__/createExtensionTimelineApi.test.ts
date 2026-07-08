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
import { extensionTransitionRegistry } from "../../../transitions/extensions/ExtensionTransitionRegistry";

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

  it("creates, updates, lists, and removes extension-owned transitions", () => {
    const scope = createScope("example.wipes");
    const registration = extensionTransitionRegistry.bind(scope).register({
      id: "push",
      apiVersion: 1,
      label: "Push",
      glyph: "P",
      schemaVersion: 1,
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            {
              type: "slider",
              name: "distance",
              label: "Distance",
              defaultValue: 1,
              min: 0,
              max: 2,
            },
          ],
        },
      ],
      renderFrame: ({ progress, parameters }) => ({
        outgoingTransforms: [
          {
            type: "position",
            parameters: {
              x:
                -100 *
                progress *
                (typeof parameters.distance === "number"
                  ? parameters.distance
                  : 1),
              y: 0,
            },
          },
        ],
      }),
    });

    try {
      const outgoing = createExtensionClip("outgoing", "example.shapes");
      outgoing.trackId = "track-lower";
      outgoing.start = 0;
      outgoing.timelineDuration = 96_000;
      outgoing.transformedDuration = 96_000;
      outgoing.croppedSourceDuration = 96_000;
      const incoming = createExtensionClip("incoming", "example.shapes");
      incoming.trackId = "track-upper";
      incoming.start = 48_000;
      incoming.timelineDuration = 96_000;
      incoming.transformedDuration = 96_000;
      incoming.croppedSourceDuration = 96_000;
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [
          {
            id: "track-upper",
            label: "Upper",
            type: "visual",
            isVisible: true,
            isLocked: false,
            isMuted: false,
          },
          {
            id: "track-lower",
            label: "Lower",
            type: "visual",
            isVisible: true,
            isLocked: false,
            isMuted: false,
          },
        ],
        clips: [outgoing, incoming],
        transitions: [],
      });

      const api = createExtensionTimelineApi(scope);
      let transitionId = "";
      const createResult = api.transaction("Create push", (transaction) => {
        transitionId = transaction.createTransition({
          transitionType: "push",
          outgoingClipId: "outgoing",
          incomingClipId: "incoming",
          parameters: { distance: 0.75 },
        });
      });
      expect(createResult).toEqual({
        ok: true,
        changed: true,
        label: "Create push",
      });

      expect(api.listTransitions()).toEqual([
        expect.objectContaining({
          id: transitionId,
          type: "example.wipes/push",
          schemaVersion: 1,
          parameters: { distance: 0.75 },
        }),
      ]);

      expect(
        api.transaction("Update push", (transaction) => {
          transaction.updateTransitionParameters(transitionId, {
            distance: 0.25,
          });
        }),
      ).toMatchObject({ ok: true, changed: true });
      expect(useTimelineStore.getState().transitions[0]?.parameters).toEqual({
        distance: 0.25,
      });

      expect(
        api.transaction("Remove push", (transaction) => {
          transaction.removeTransition(transitionId);
        }),
      ).toMatchObject({ ok: true, changed: true });
      expect(useTimelineStore.getState().transitions).toEqual([]);

      expect(useTimelineStore.getState().undo()).toBe(true);
      expect(useTimelineStore.getState().transitions[0]?.id).toBe(transitionId);
    } finally {
      registration.dispose();
    }
  });

  it("reports transition-specific staging failures", () => {
    const api = createExtensionTimelineApi(createScope("example.wipes"));

    expect(
      api.transaction("Create missing transition", (transaction) => {
        transaction.createTransition({
          transitionType: "missing",
          outgoingClipId: "shape-1",
          incomingClipId: "tracker-1",
        });
      }),
    ).toMatchObject({
      ok: false,
      code: "transition_type_not_found",
    });

    expect(
      api.transaction("Remove missing transition", (transaction) => {
        transaction.removeTransition("transition-missing");
      }),
    ).toMatchObject({
      ok: false,
      code: "transition_not_found",
    });
  });

  it("rejects transition removal on behalf of another extension before commit", () => {
    const outgoing = createExtensionClip("outgoing", "example.shapes");
    outgoing.trackId = "track-lower";
    outgoing.start = 0;
    outgoing.timelineDuration = 96_000;
    outgoing.transformedDuration = 96_000;
    outgoing.croppedSourceDuration = 96_000;
    const incoming = createExtensionClip("incoming", "example.shapes");
    incoming.trackId = "track-upper";
    incoming.start = 48_000;
    incoming.timelineDuration = 96_000;
    incoming.transformedDuration = 96_000;
    incoming.croppedSourceDuration = 96_000;
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track-upper",
          label: "Upper",
          type: "visual",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
        {
          id: "track-lower",
          label: "Lower",
          type: "visual",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [outgoing, incoming],
      transitions: [
        {
          id: "transition-owned",
          type: "example.other/wipe",
          outgoingClipId: "outgoing",
          incomingClipId: "incoming",
          schemaVersion: 1,
          parameters: {},
        },
      ],
    });

    const api = createExtensionTimelineApi(createScope("example.wipes"));
    expect(
      api.transaction("Remove other transition", (transaction) => {
        transaction.removeTransition("transition-owned");
      }),
    ).toMatchObject({
      ok: false,
      code: "wrong_owner",
    });
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
