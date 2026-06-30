import { beforeEach, describe, expect, it } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionTimelineTransaction,
} from "../..";
import type {
  ExtensionTimelineClip,
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

describe("createExtensionTimelineApi", () => {
  beforeEach(() => {
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
        createExtensionClip("shape-1", "example.shapes"),
        createExtensionClip("tracker-1", "example.tracker"),
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
});
