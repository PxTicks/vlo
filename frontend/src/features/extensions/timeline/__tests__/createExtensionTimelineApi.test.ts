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
import { useAssetStore } from "../../../userAssets";

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
    useAssetStore.setState({
      assets: [
        {
          id: "paint-mask-asset",
          hash: "paint-mask-hash",
          name: "Paint mask",
          type: "image",
          src: "blob:paint-mask",
          createdAt: 1,
        },
      ],
    });
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

  it("creates and edits an owned bitmap mask through undoable transactions", () => {
    const api = createExtensionTimelineApi(createScope("example.paint"));
    let maskId = "";

    expect(
      api.transaction("Add painted mask", (transaction) => {
        maskId = transaction.addClipMask("shape-1", {
          maskType: "brush",
          name: "Painted area",
          parameters: { baseWidth: 200, baseHeight: 100 },
          assetId: "paint-mask-asset",
          paintedBounds: { x: 10, y: 20, width: 80, height: 40 },
          activeRange: { startSourceTicks: 5, endSourceTicks: 95 },
        });
      }),
    ).toMatchObject({ ok: true, changed: true });

    expect(maskId).toMatch(/^extension\/example\.paint\//);
    expect(api.listClipMasks("shape-1")).toContainEqual(
      expect.objectContaining({
        localId: maskId,
        name: "Painted area",
        maskType: "brush",
        assetId: "paint-mask-asset",
        parameters: { baseWidth: 200, baseHeight: 100 },
        activeRange: { startSourceTicks: 5, endSourceTicks: 95 },
      }),
    );

    expect(
      api.transaction("Resize painted mask", (transaction) => {
        transaction.updateMaskParameters("shape-1", maskId, {
          baseWidth: 240,
          baseHeight: 120,
        });
        transaction.setMaskActiveRange("shape-1", maskId, null);
      }),
    ).toMatchObject({ ok: true, changed: true });
    const updated = api
      .listClipMasks("shape-1")
      .find((mask) => mask.localId === maskId);
    expect(updated).toMatchObject({
      parameters: { baseWidth: 240, baseHeight: 120 },
    });
    expect(updated?.activeRange).toBeUndefined();

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(api.listClipMasks("shape-1")).toContainEqual(
      expect.objectContaining({
        localId: maskId,
        parameters: { baseWidth: 200, baseHeight: 100 },
        activeRange: { startSourceTicks: 5, endSourceTicks: 95 },
      }),
    );
  });

  it("coalesces consecutive extension transactions by owner-qualified key", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));

    for (const [index, points] of [6, 7].entries()) {
      expect(
        api.transaction(
          "Paint stroke",
          (transaction) => {
            transaction.updatePayload("shape-1", {
              extensionId: "example.shapes",
              typeId: "shape",
              schemaVersion: 1,
              data: { points },
            });
          },
          {
            coalesce: {
              key: "stroke-1",
              phase: index === 1 ? "end" : "continue",
            },
          },
        ),
      ).toMatchObject({ ok: true, changed: true });
    }

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({
      extensionPayload: { data: { points: 5 } },
    });
    expect(useTimelineStore.getState().undo()).toBe(false);
  });

  it("does not reopen a coalescing key after its interaction ends", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));
    const update = (points: number, phase: "continue" | "end") =>
      api.transaction(
        "Paint stroke",
        (transaction) => {
          transaction.updatePayload("shape-1", {
            extensionId: "example.shapes",
            typeId: "shape",
            schemaVersion: 1,
            data: { points },
          });
        },
        { coalesce: { key: "reused-key", phase } },
      );

    expect(update(6, "end")).toMatchObject({ ok: true, changed: true });
    expect(update(7, "end")).toMatchObject({ ok: true, changed: true });

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({ extensionPayload: { data: { points: 6 } } });
    expect(useTimelineStore.getState().undo()).toBe(true);
  });

  it("bounds a coalesced interaction to finite-sized history entries", () => {
    const api = createExtensionTimelineApi(createScope("example.shapes"));

    for (let index = 0; index < 257; index += 1) {
      expect(
        api.transaction(
          "Long paint stroke",
          (transaction) => {
            transaction.updatePayload("shape-1", {
              extensionId: "example.shapes",
              typeId: "shape",
              schemaVersion: 1,
              data: { points: index + 6 },
            });
          },
          {
            coalesce: {
              key: "long-stroke",
              phase: index === 256 ? "end" : "continue",
            },
          },
        ),
      ).toMatchObject({ ok: true, changed: true });
    }

    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({ extensionPayload: { data: { points: 261 } } });
    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(
      useTimelineStore.getState().clips.find((clip) => clip.id === "shape-1"),
    ).toMatchObject({ extensionPayload: { data: { points: 5 } } });
  });

  it("rejects unsupported masks and cross-owner mask edits atomically", () => {
    const api = createExtensionTimelineApi(createScope("example.paint"));

    expect(
      api.transaction("Unsupported mask", (transaction) => {
        transaction.addClipMask("shape-1", {
          maskType: "future-mask",
          parameters: { baseWidth: 10, baseHeight: 10 },
        });
      }),
    ).toMatchObject({ ok: false, code: "mask_type_not_supported" });

    expect(
      api.transaction("Edit host mask", (transaction) => {
        transaction.updateMaskParameters("shape-1", "mask-1", {
          baseWidth: 10,
          baseHeight: 10,
        });
      }),
    ).toMatchObject({ ok: false, code: "wrong_owner" });
    expect(api.listClipMasks("shape-1")[0]?.parameters).toEqual({
      baseWidth: 200,
      baseHeight: 100,
    });
  });

  it("does not confuse an underscore-prefixed extension ID for the mask owner", () => {
    const creator = createExtensionTimelineApi(createScope("acme.paint_pro"));
    let maskId = "";
    expect(
      creator.transaction("Create owned mask", (transaction) => {
        maskId = transaction.addClipMask("shape-1", {
          maskType: "brush",
          parameters: { baseWidth: 200, baseHeight: 100 },
          assetId: "paint-mask-asset",
        });
      }),
    ).toMatchObject({ ok: true, changed: true });

    const prefixOwner = createExtensionTimelineApi(createScope("acme.paint"));
    expect(
      prefixOwner.transaction("Edit another owner mask", (transaction) => {
        transaction.updateMaskParameters("shape-1", maskId, {
          baseWidth: 10,
          baseHeight: 10,
        });
      }),
    ).toMatchObject({ ok: false, code: "wrong_owner" });
    expect(
      creator
        .listClipMasks("shape-1")
        .find((mask) => mask.localId === maskId)?.parameters,
    ).toEqual({ baseWidth: 200, baseHeight: 100 });
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

/**
 * Clip and track writes let an extension express intent; the host keeps
 * correctness. These cover both halves: the request the host adjusts, and the
 * request it refuses.
 */
describe("createExtensionTimelineApi clip and track commands", () => {
  const VIDEO_ASSET = {
    id: "video-asset",
    hash: "video-hash",
    name: "Take 1.mp4",
    type: "video" as const,
    src: "blob:take-1",
    duration: 4,
    createdAt: 1,
  };

  const AUDIO_ASSET = {
    id: "audio-asset",
    hash: "audio-hash",
    name: "Room tone.wav",
    type: "audio" as const,
    src: "blob:room-tone",
    duration: 4,
    createdAt: 2,
  };

  function seedTimeline(): void {
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
      clips: [],
      transitions: [],
    });
    useTimelineStore.getState().setTimelinePersistenceSuspended(true);
    useAssetStore.setState({ assets: [VIDEO_ASSET, AUDIO_ASSET] });
  }

  function clipById(clipId: string) {
    return useTimelineStore.getState().clips.find((clip) => clip.id === clipId);
  }

  beforeEach(seedTimeline);

  it("places an asset-backed clip and reports the host-generated ID", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let clipId = "";

    const result = api.transaction("Place take", (transaction) => {
      clipId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 500,
      });
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(clipById(clipId)).toMatchObject({
      type: "video",
      assetId: "video-asset",
      trackId: "track-visual",
      start: 500,
    });
  });

  it("adjusts an overlapping placement instead of overlapping", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let firstId = "";
    let secondId = "";

    api.transaction("Place first", (transaction) => {
      firstId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 0,
      });
    });
    const first = clipById(firstId);
    expect(first).toBeDefined();

    // Ask for a start squarely inside the existing clip.
    api.transaction("Place second", (transaction) => {
      secondId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: Math.round((first?.timelineDuration ?? 0) / 2),
      });
    });

    const second = clipById(secondId);
    expect(second).toBeDefined();
    // The host resolved it exactly as a user's drag would: no overlap, and the
    // extension's requested tick was not honoured verbatim.
    const firstEnd = (first?.start ?? 0) + (first?.timelineDuration ?? 0);
    expect(second?.start).toBeGreaterThanOrEqual(firstEnd);
  });

  it("refuses an unknown asset and commits nothing", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));

    const result = api.transaction("Place missing", (transaction) => {
      transaction.createClip({ assetId: "nope", startTicks: 0 });
    });

    expect(result).toMatchObject({ ok: false, code: "asset_not_found" });
    expect(useTimelineStore.getState().clips).toHaveLength(0);
  });

  it("refuses a populated track whose class cannot hold the media", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let audioTrackId = "";

    // An empty typed track still takes the class of its first clip, so the
    // track has to be populated for the mismatch to be real.
    api.transaction("Seed audio", (transaction) => {
      audioTrackId = transaction.createTrack({ label: "Audio", type: "audio" });
      transaction.createClip({
        assetId: "audio-asset",
        startTicks: 0,
        trackId: audioTrackId,
      });
    });
    expect(
      useTimelineStore
        .getState()
        .clips.filter((clip) => clip.trackId === audioTrackId),
    ).toHaveLength(1);

    const result = api.transaction("Misplace", (transaction) => {
      transaction.createClip({
        assetId: "video-asset",
        startTicks: 0,
        trackId: audioTrackId,
      });
    });

    expect(result).toMatchObject({ ok: false, code: "track_type_mismatch" });
  });

  it("snaps a move off a neighbour's edge but refuses to land on top of one", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let anchorId = "";
    let movedId = "";
    api.transaction("Seed", (transaction) => {
      anchorId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 0,
      });
      movedId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 1_000_000,
      });
    });
    const anchor = clipById(anchorId);
    const anchorEnd = (anchor?.start ?? 0) + (anchor?.timelineDuration ?? 0);

    // Overlapping the anchor's tail is a partial collision: the host snaps the
    // clip to the anchor's end, the same as dragging there would.
    const snapped = api.transaction("Nudge into anchor", (transaction) => {
      transaction.moveClip(movedId, { startTicks: anchorEnd - 1_000 });
    });
    expect(snapped.ok).toBe(true);
    expect(clipById(movedId)?.start).toBe(anchorEnd);

    // Dropping squarely onto the anchor has no correct answer — the host blocks
    // it for a user drag too — so the transaction fails and nothing moves.
    const dropped = api.transaction("Drop onto anchor", (transaction) => {
      transaction.moveClip(movedId, { startTicks: 0 });
    });
    expect(dropped).toMatchObject({ ok: false, code: "no_free_slot" });
    expect(clipById(movedId)?.start).toBe(anchorEnd);
  });

  it("keeps entity ownership and mask subordination out of the clip commands", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let entityId = "";
    api.transaction("Seed entity", (transaction) => {
      entityId = transaction.createEntity({
        name: "Owned",
        startTicks: 0,
        durationTicks: 100,
        payload: {
          extensionId: "example.importer",
          typeId: "shape",
          schemaVersion: 1,
          data: {},
        },
      });
    });

    const moved = api.transaction("Move entity as clip", (transaction) => {
      transaction.moveClip(entityId, { startTicks: 500 });
    });
    expect(moved).toMatchObject({ ok: false, code: "invalid_command" });
    expect(moved.ok === false && moved.message).toMatch(/entity commands/);
    expect(clipById(entityId)?.start).toBe(0);

    const removed = api.transaction("Remove entity as clip", (transaction) => {
      transaction.removeClip(entityId);
    });
    expect(removed).toMatchObject({ ok: false, code: "invalid_command" });
    expect(clipById(entityId)).toBeDefined();
  });

  it("clamps a trim to the media and the minimum duration", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let clipId = "";
    api.transaction("Seed", (transaction) => {
      clipId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 0,
      });
    });
    const original = clipById(clipId);
    const originalDuration = original?.timelineDuration ?? 0;

    // Ask for far more than the source holds.
    const result = api.transaction("Over-extend", (transaction) => {
      transaction.trimClip(clipId, { endTicks: originalDuration * 10 });
    });

    expect(result.ok).toBe(true);
    expect(clipById(clipId)?.timelineDuration).toBeLessThanOrEqual(
      originalDuration,
    );
  });

  it("splits a clip inside its bounds and refuses a tick outside them", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let clipId = "";
    api.transaction("Seed", (transaction) => {
      clipId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 0,
      });
    });
    const duration = clipById(clipId)?.timelineDuration ?? 0;

    const outside = api.transaction("Split past end", (transaction) => {
      transaction.splitClip(clipId, duration + 1_000);
    });
    expect(outside).toMatchObject({ ok: false, code: "invalid_command" });
    expect(useTimelineStore.getState().clips).toHaveLength(1);

    const inside = api.transaction("Split", (transaction) => {
      transaction.splitClip(clipId, Math.round(duration / 2));
    });
    expect(inside.ok).toBe(true);
    expect(useTimelineStore.getState().clips).toHaveLength(2);
  });

  it("removes a clip and round-trips through undo", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let clipId = "";
    api.transaction("Seed", (transaction) => {
      clipId = transaction.createClip({
        assetId: "video-asset",
        trackId: "track-visual",
        startTicks: 0,
      });
    });

    const result = api.transaction("Remove", (transaction) => {
      transaction.removeClip(clipId);
    });

    expect(result.ok).toBe(true);
    expect(clipById(clipId)).toBeUndefined();
    expect(useTimelineStore.getState().undo()).toBe(true);
    expect(clipById(clipId)).toBeDefined();
  });

  it("creates, updates, and removes tracks, refusing to drop a populated one", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));
    let trackId = "";

    api.transaction("Add track", (transaction) => {
      trackId = transaction.createTrack({ label: "Overlays", index: 0 });
    });
    expect(api.listTracks()[0]).toMatchObject({
      id: trackId,
      label: "Overlays",
      index: 0,
    });

    api.transaction("Hide track", (transaction) => {
      transaction.updateTrack(trackId, { isVisible: false, isLocked: true });
    });
    expect(api.listTracks().find((track) => track.id === trackId)).toMatchObject(
      { isVisible: false, isLocked: true },
    );

    api.transaction("Fill track", (transaction) => {
      transaction.createClip({
        assetId: "video-asset",
        trackId,
        startTicks: 0,
      });
    });
    const occupied = api.transaction("Drop populated", (transaction) => {
      transaction.removeTrack(trackId);
    });
    expect(occupied).toMatchObject({ ok: false, code: "track_not_empty" });
    expect(api.listTracks().some((track) => track.id === trackId)).toBe(true);

    const missing = api.transaction("Drop unknown", (transaction) => {
      transaction.removeTrack("no-such-track");
    });
    expect(missing).toMatchObject({ ok: false, code: "track_not_found" });
  });

  it("rejects malformed input before any command is staged", () => {
    const api = createExtensionTimelineApi(createScope("example.importer"));

    expect(
      api.transaction("Bad tick", (transaction) => {
        transaction.moveClip("clip-1", { startTicks: Number.NaN });
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });

    expect(
      api.transaction("Empty trim", (transaction) => {
        transaction.trimClip("clip-1", {});
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });

    expect(
      api.transaction("Bad track type", (transaction) => {
        transaction.createTrack({
          type: "prompt" as unknown as "visual",
        });
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
  });
});
