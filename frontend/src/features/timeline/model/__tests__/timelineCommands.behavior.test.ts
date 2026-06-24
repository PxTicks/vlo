import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClipTransform,
  MaskTimelineClip,
  StandardTimelineClip,
  TextTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { Component } from "../../../../types/Components";
import {
  addClipComponentToDraft,
  addClipMaskToDraft,
  addClipTransformToDraft,
  addTrackToDraft,
  clipReferencesAssetId,
  copySelectedClips,
  duplicateClipMaskInDraft,
  getTimelineClipsAtTime,
  insertTrackIntoDraft,
  moveClipsInDraft,
  removeClipComponentFromDraft,
  removeClipTransformFromDraft,
  replaceClipAssetInDraft,
  setClipMaskBooleanExpressionInDraft,
  setClipMaskCompositeTransformsInDraft,
  setClipMaskCompositionAlgebraInDraft,
  setClipMaskExpressionEnabledInDraft,
  setClipTransformsAndShapeInDraft,
  splitClipInDraft,
  toggleClipMuteInDraft,
  toggleTrackMuteInDraft,
  toggleTrackVisibilityInDraft,
  updateClipComponentInDraft,
  updateClipDurationInDraft,
  updateClipMaskInDraft,
  updateClipPositionInDraft,
  updateClipShapeInDraft,
  updateClipTransformInDraft,
  updateTextClipDataInDraft,
  withTimelineClipDefaults,
} from "../timelineCommands";

function track(
  id: string,
  type?: TimelineTrack["type"],
): TimelineTrack {
  return {
    id,
    label: id,
    isVisible: true,
    isLocked: false,
    isMuted: false,
    ...(type ? { type } : {}),
  };
}

function video(
  id: string,
  trackId = "visual",
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `${id}-asset`,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function audio(id: string, trackId = "audio"): TimelineClip {
  return {
    ...video(id, trackId),
    type: "audio",
    assetId: `${id}-audio`,
  } as TimelineClip;
}

function mask(parent: TimelineClip, localId = "one"): MaskTimelineClip {
  return {
    id: `${parent.id}::mask::${localId}`,
    parentClipId: parent.id,
    trackId: parent.trackId,
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 100,
    start: parent.start,
    timelineDuration: parent.timelineDuration,
    croppedSourceDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    transformations: [],
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
  };
}

function draft(clips: TimelineClip[] = [], tracks: TimelineTrack[] = []) {
  return { clips, tracks };
}

describe("timelineCommands behavior", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("normalizes defaults by clip kind", () => {
    const maskClip = mask(video("parent"));
    expect(withTimelineClipDefaults(maskClip)).toBe(maskClip);

    const text = {
      ...video("text"),
      type: "text",
      name: "old",
      sourceDuration: null,
      textData: {
        content: "  Updated title  ",
        fontFamily: "Arial",
        fontSize: 20,
        fill: "#fff",
        align: "left",
        strokeColor: "#000",
        strokeWidth: 0,
      },
    } as TextTimelineClip;
    expect(withTimelineClipDefaults(text)).toMatchObject({
      name: "Updated title",
    });

    const adjustment = {
      ...video("adjustment"),
      type: "adjustment",
      depth: 1,
    } as TimelineClip;
    expect(withTimelineClipDefaults(adjustment)).toMatchObject({
      retimingMode: "static",
    });

    const audioClip = audio("audio");
    expect(withTimelineClipDefaults(audioClip)).toBe(audioClip);

    const fitted = video("fitted", "visual", {
      transformations: [
        {
          id: "fit",
          type: "fitMode",
          isEnabled: true,
          parameters: { fitMode: "contain" },
        },
      ],
    });
    expect(withTimelineClipDefaults(fitted)).toBe(fitted);
    expect(withTimelineClipDefaults(video("plain")).transformations[0]?.type).toBe(
      "fitMode",
    );
  });

  it("checks assets and copies selected clips in track/time order", () => {
    const late = video("late", "top", { start: 20 });
    const early = video("early", "top", { start: 10 });
    const lower = audio("lower", "bottom");
    const maskClip = mask(late);
    expect(clipReferencesAssetId(late, "late-asset")).toBe(true);
    expect(clipReferencesAssetId(maskClip, "late-asset")).toBe(false);
    expect(copySelectedClips([], [late], [])).toEqual([]);
    expect(copySelectedClips([maskClip.id], [maskClip], [])).toEqual([]);

    const copied = copySelectedClips(
      [late.id, early.id, lower.id],
      [late, lower, early],
      [track("top"), track("bottom")],
    );
    expect(copied.map((clip) => clip.name)).toEqual(["early", "late", "lower"]);
    expect(copied.every((clip) => ![late.id, early.id, lower.id].includes(clip.id))).toBe(
      true,
    );
  });

  it("adds and inserts tracks at clamped positions", () => {
    const state = draft([], [track("existing")]);
    addTrackToDraft(state);
    expect(state.tracks).toHaveLength(2);
    insertTrackIntoDraft(state, -10, track("first"));
    insertTrackIntoDraft(state, 100, track("last"));
    expect(state.tracks[0]?.id).toBe("first");
    expect(state.tracks.at(-1)?.id).toBe("last");
  });

  it("moves clips, follows parent masks, and synchronizes track types", () => {
    const parent = video("parent", "visual");
    const child = mask(parent);
    const state = draft(
      [parent, child],
      [track("visual", "visual"), track("empty", "audio")],
    );
    moveClipsInDraft(state, [
      { clipId: "missing", start: 10 },
      { clipId: child.id, start: 10 },
      { clipId: parent.id, start: -4.4, trackId: "empty" },
    ]);
    expect(state.clips.find((clip) => clip.id === parent.id)).toMatchObject({
      start: 0,
      trackId: "empty",
    });
    expect(state.clips.find((clip) => clip.id === child.id)).toMatchObject({
      start: 0,
      trackId: "empty",
    });
    expect(state.tracks.find((item) => item.id === "empty")?.type).toBe(
      "visual",
    );

    updateClipPositionInDraft(state, parent.id, 12.6);
    expect(state.clips.find((clip) => clip.id === parent.id)?.start).toBe(13);
  });

  it("rejects incompatible populated-track moves as a batch", () => {
    const movingAudio = audio("moving", "audio");
    const visual = video("visual", "visual");
    const state = draft(
      [movingAudio, visual],
      [track("audio", "audio"), track("visual", "visual")],
    );
    moveClipsInDraft(state, [
      { clipId: movingAudio.id, start: 5, trackId: "visual" },
    ]);
    expect(state.clips.find((clip) => clip.id === movingAudio.id)).toMatchObject({
      start: 0,
      trackId: "audio",
    });
  });

  it("replaces matching assets and edits clip timing/text", () => {
    const visual = video("visual");
    const text = {
      ...video("text"),
      type: "text",
      sourceDuration: null,
      textData: {
        content: "Before",
        fontFamily: "Arial",
        fontSize: 20,
        fill: "#fff",
        align: "left",
        strokeColor: "#000",
        strokeWidth: 0,
      },
    } as TextTimelineClip;
    const adjustment = {
      ...video("adjustment"),
      type: "adjustment",
      depth: 1,
    } as TimelineClip;
    const state = draft([visual, text, adjustment]);

    replaceClipAssetInDraft(state, visual.id, {
      id: "wrong",
      name: "Wrong",
      type: "audio",
      src: "blob:wrong",
      hash: "wrong",
      createdAt: 1,
    });
    replaceClipAssetInDraft(state, visual.id, {
      id: "replacement",
      name: "Replacement",
      type: "video",
      src: "blob:video",
      hash: "video",
      createdAt: 1,
    });
    expect(state.clips[0]).toMatchObject({
      assetId: "replacement",
      name: "Replacement",
    });

    updateClipShapeInDraft(state, adjustment.id, {
      start: 1.6,
      timelineDuration: 41.4,
      offset: 2.5,
      transformedDuration: 43.6,
      transformedOffset: 4.5,
      croppedSourceDuration: 44.6,
    });
    expect(state.clips.find((clip) => clip.id === adjustment.id)).toMatchObject({
      start: 2,
      timelineDuration: 41,
      sourceDuration: 45,
    });
    updateClipDurationInDraft(state, visual.id, -10);
    expect(state.clips[0]?.timelineDuration).toBeGreaterThan(0);
    updateTextClipDataInDraft(state, text.id, { content: "After" });
    expect(state.clips.find((clip) => clip.id === text.id)).toMatchObject({
      name: "After",
      textData: expect.objectContaining({ content: "After" }),
    });
  });

  it("adds, updates, replaces, and removes transforms", () => {
    const clip = video("clip");
    const state = draft([clip]);
    const transform = {
      id: "opacity",
      type: "opacity",
      isEnabled: true,
      parameters: { opacity: 0.5 },
    } as ClipTransform;
    addClipTransformToDraft(state, clip.id, transform);
    updateClipTransformInDraft(state, clip.id, transform.id, {
      isEnabled: false,
    });
    expect(state.clips[0]?.transformations[0]?.isEnabled).toBe(false);

    setClipTransformsAndShapeInDraft(state, clip.id, [transform], {
      start: 7.7,
    });
    expect(state.clips[0]).toMatchObject({
      start: 8,
      transformations: [transform],
    });
    removeClipTransformFromDraft(state, clip.id, transform.id);
    expect(state.clips[0]?.transformations).toEqual([]);
    removeClipTransformFromDraft(state, "missing", "missing");
  });

  it("updates mask composition APIs and tolerates invalid parents", () => {
    const parent = video("parent");
    const state = draft([parent]);
    setClipMaskCompositeTransformsInDraft(state, "missing", []);
    setClipMaskCompositionAlgebraInDraft(state, "missing", "normal");
    setClipMaskBooleanExpressionInDraft(state, "missing", null);
    setClipMaskExpressionEnabledInDraft(state, "missing", true);

    setClipMaskBooleanExpressionInDraft(state, parent.id, {
      kind: "mask_ref",
      maskId: "one",
    });
    setClipMaskExpressionEnabledInDraft(state, parent.id, false);
    setClipMaskExpressionEnabledInDraft(state, parent.id, true);
    setClipMaskCompositionAlgebraInDraft(state, parent.id, "normal");
    setClipMaskCompositeTransformsInDraft(state, parent.id, []);
    expect((state.clips[0] as StandardTimelineClip).components).toBeDefined();
  });

  it("duplicates and fully updates mask clips", () => {
    const parent = video("parent");
    const child = mask(parent);
    (parent as StandardTimelineClip).components = [
      {
        id: "ref",
        type: "mask_ref",
        parameters: { maskClipId: child.id },
      },
    ];
    const state = draft([parent, child]);
    expect(duplicateClipMaskInDraft(state, "missing", "one")).toBeNull();
    expect(duplicateClipMaskInDraft(state, parent.id, "missing")).toBeNull();
    expect(duplicateClipMaskInDraft(state, parent.id, "one")).toBeTruthy();

    const transforms = [
      {
        id: "mask-opacity",
        type: "opacity",
        isEnabled: true,
        parameters: { opacity: 0.4 },
      } as ClipTransform,
    ];
    updateClipMaskInDraft(state, parent.id, "one", {
      name: "Renamed",
      maskMode: "preview",
      maskInverted: true,
      sam2GrowAmount: 2,
      maskParameters: { baseWidth: 200, baseHeight: 100 },
      maskPoints: [{ x: 1, y: 2, label: 1, timeTicks: 0 }],
      sam2MaskAssetId: "sam2",
      sam2GeneratedPointsHash: "hash",
      sam2LastGeneratedAt: 123,
      brushMaskAssetId: null as never,
      brushPaintedBounds: null as never,
      activeRange: { startSourceTicks: 80, endSourceTicks: 20 },
      transformations: transforms,
    });
    expect(child).toMatchObject({
      name: "Renamed",
      maskMode: "preview",
      maskInverted: true,
      activeRange: { startSourceTicks: 20, endSourceTicks: 80 },
    });
    updateClipMaskInDraft(state, parent.id, "one", { activeRange: null });
    expect(child.activeRange).toBeUndefined();
    updateClipMaskInDraft(state, "missing", "one", { name: "ignored" });
  });

  it("manages components, visibility, mute, splitting, and time queries", () => {
    const clip = video("clip", "track", { start: 10, timelineDuration: 20 });
    const state = draft([clip], [track("track", "visual")]);
    const component: Component = {
      id: "range",
      type: "range_mask",
      parameters: {
        startSourceTicks: 1,
        endSourceTicks: 2,
        isActive: true,
      },
    };
    addClipComponentToDraft(state, clip.id, component);
    updateClipComponentInDraft(state, clip.id, component.id, (current) =>
      current.type === "range_mask"
        ? {
            ...current,
            parameters: { ...current.parameters, endSourceTicks: 4 },
          }
        : current,
    );
    expect((state.clips[0] as StandardTimelineClip).components?.[0]).toMatchObject({
      parameters: { endSourceTicks: 4 },
    });
    removeClipComponentFromDraft(state, clip.id, component.id);
    expect((state.clips[0] as StandardTimelineClip).components).toBeUndefined();
    updateClipComponentInDraft(state, "missing", "x", (value) => value);
    removeClipComponentFromDraft(state, "missing", "x");

    toggleTrackVisibilityInDraft(state, "track");
    toggleTrackMuteInDraft(state, "track");
    toggleClipMuteInDraft(state, clip.id);
    toggleClipMuteInDraft(state, "missing");
    expect(state.tracks[0]).toMatchObject({ isVisible: false, isMuted: true });
    expect(state.clips[0]).toMatchObject({ isMuted: true });

    expect(splitClipInDraft(state, "missing", 15)).toBeNull();
    expect(getTimelineClipsAtTime(state.clips, 9)).toEqual([]);
    expect(getTimelineClipsAtTime(state.clips, 10)).toHaveLength(1);
    expect(getTimelineClipsAtTime(state.clips, 30)).toEqual([]);
  });

  it("ignores mask attachment to invalid parents", () => {
    const parent = video("parent");
    const state = draft([parent, mask(parent)]);
    addClipMaskToDraft(state, "missing", {} as never);
    addClipMaskToDraft(state, `${parent.id}::mask::one`, {} as never);
    expect(state.clips).toHaveLength(2);
  });
});
