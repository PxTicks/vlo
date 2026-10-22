import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";
import { describe, expect, it } from "vitest";
import {
  getIncludedClipsForSelection,
  getIncludedTracksForSelection,
  getTicksPerFrame,
  normalizeDetachedTimelineSelection,
  normalizeTimelineSelection,
  resolveSelectionFps,
  resolveSelectionFrameOffset,
  resolveSelectionFrameStep,
  selectionHasMaskClip,
  snapFrameCountToStep,
  snapSteppedRangeEdge,
} from "../timelineSelection";
import {
  createPointTimelineSelection,
  createTimelineSelection,
  createTimelineSelectionFromClipIds,
} from "../createTimelineSelection";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useProjectStore } from "../../../project";

describe("timelineSelection helpers", () => {
  it.each(["16:9", "9:16", "5:3"] as const)(
    "captures the %s project canvas on point and range selections",
    (aspectRatio) => {
      const config = useProjectStore.getState().config;
      try {
        useProjectStore.setState({ config: { ...config, aspectRatio } });
        const point = createPointTimelineSelection(0);
        const range = createTimelineSelection(0, TICKS_PER_SECOND);
        useProjectStore.setState({ config: { ...config, aspectRatio: "1:1" } });

        expect(point.aspectRatio).toBe(aspectRatio);
        expect(range.aspectRatio).toBe(aspectRatio);
        expect(normalizeDetachedTimelineSelection(structuredClone(range)).aspectRatio).toBe(aspectRatio);
      } finally {
        useProjectStore.setState({ config });
      }
    },
  );

  it("resolves selection fps over project fps", () => {
    expect(resolveSelectionFps({ fps: 24 }, 30)).toBe(24);
    expect(resolveSelectionFps({ fps: null }, 30)).toBe(30);
  });

  it("falls back to project fps when selection fps is missing", () => {
    expect(resolveSelectionFps({}, 30)).toBe(30);
  });

  it("resolves frame step with sane defaults", () => {
    expect(resolveSelectionFrameStep({ frameStep: 8 })).toBe(8);
    expect(resolveSelectionFrameStep({ frameStep: 0 })).toBe(1);
    expect(resolveSelectionFrameStep(undefined)).toBe(1);
  });

  it("snaps frame counts to step*n + 1", () => {
    expect(snapFrameCountToStep(30, 4, "floor")).toBe(29);
    expect(snapFrameCountToStep(31, 4, "floor")).toBe(29);
    expect(snapFrameCountToStep(1, 8, "floor")).toBe(1);
  });

  it("resolves frame offset with sane defaults", () => {
    expect(resolveSelectionFrameOffset({ frameOffset: 5 })).toBe(5);
    expect(resolveSelectionFrameOffset({ frameOffset: 0 })).toBe(1);
    expect(resolveSelectionFrameOffset(undefined)).toBe(1);
  });

  it("snaps frame counts to step*n + offset", () => {
    // MiniMax H3's 17k + 5 grid: 5, 22, 39, 56, ...
    expect(snapFrameCountToStep(56, 17, "floor", 5)).toBe(56);
    expect(snapFrameCountToStep(60, 17, "floor", 5)).toBe(56);
    expect(snapFrameCountToStep(72, 17, "ceil", 5)).toBe(73);
    expect(snapFrameCountToStep(70, 17, "nearest", 5)).toBe(73);
    // Never falls below the smallest valid count on the grid.
    expect(snapFrameCountToStep(3, 17, "floor", 5)).toBe(5);
    // A step of 1 still respects the offset as a minimum.
    expect(snapFrameCountToStep(3, 1, "floor", 5)).toBe(5);
    expect(snapFrameCountToStep(9, 1, "floor", 5)).toBe(9);
  });

  it("snaps a bounded moving range edge while preserving its anchor", () => {
    expect(
      snapSteppedRangeEdge({
        edge: "end",
        proposedTick: 630,
        fixedTick: 0,
        ticksPerFrame: 100,
        frameStep: 4,
        maxTick: 2_000,
      }),
    ).toBe(500);
    expect(
      snapSteppedRangeEdge({
        edge: "start",
        proposedTick: 1_370,
        fixedTick: 2_000,
        ticksPerFrame: 100,
        frameStep: 4,
        minTick: 0,
      }),
    ).toBe(1_500);
  });

  it("snaps a moving range edge onto an offset grid", () => {
    // 100 ticks per frame, so 56 frames of a 17k+5 grid land 5_600 ticks out.
    expect(
      snapSteppedRangeEdge({
        edge: "end",
        proposedTick: 6_000,
        fixedTick: 0,
        ticksPerFrame: 100,
        frameStep: 17,
        frameOffset: 5,
        mode: "floor",
        maxTick: 100_000,
      }),
    ).toBe(5_600);
    expect(
      snapSteppedRangeEdge({
        edge: "start",
        proposedTick: 4_000,
        fixedTick: 10_000,
        ticksPerFrame: 100,
        frameStep: 17,
        frameOffset: 5,
        mode: "floor",
        minTick: 0,
      }),
    ).toBe(4_400);
  });

  it("returns null when no grid-valid frame count fits the available room", () => {
    // Only three frames of room before minTick, but the grid starts at five:
    // clamping to the boundary would hand back an off-grid selection.
    expect(
      snapSteppedRangeEdge({
        edge: "start",
        proposedTick: 0,
        fixedTick: 300,
        ticksPerFrame: 100,
        frameStep: 17,
        frameOffset: 5,
        mode: "floor",
        minTick: 0,
      }),
    ).toBeNull();
    // Same when a maxFrameCount cap sits below the smallest valid count.
    expect(
      snapSteppedRangeEdge({
        edge: "end",
        proposedTick: 10_000,
        fixedTick: 0,
        ticksPerFrame: 100,
        frameStep: 17,
        frameOffset: 5,
        mode: "floor",
        maxFrameCount: 3,
      }),
    ).toBeNull();
    // The default grid keeps its old behaviour: one frame always fits.
    expect(
      snapSteppedRangeEdge({
        edge: "start",
        proposedTick: 0,
        fixedTick: 300,
        ticksPerFrame: 100,
        frameStep: 4,
        mode: "floor",
        minTick: 0,
      }),
    ).toBe(200);
  });

  it("computes ticks per frame from fps", () => {
    expect(getTicksPerFrame(30)).toBe(TICKS_PER_SECOND / 30);
  });

  it("filters malformed clips from saved selections and recovers from the timeline", () => {
    const timelineClip = {
      id: "clip-1",
      type: "video" as const,
      name: "Clip",
      assetId: "asset-1",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-1",
      start: 0,
    };

    expect(
      normalizeTimelineSelection(
        {
          start: 0,
          end: 100,
          clips: [null as unknown as typeof timelineClip],
          message: "  Focus on this range  ",
          includedTrackIds: ["track-1", "missing-track", "track-1"],
          tracks: [
            {
              id: "track-1",
              label: "Track 1",
              type: "visual" as const,
              isVisible: true,
              isMuted: false,
              isLocked: false,
            },
          ],
        },
        [timelineClip], 96000
      ),
    ).toEqual(makeTimelineSelection({
      start: 0,
      end: 100,
      clips: [timelineClip],
      message: "Focus on this range",
      includedTrackIds: ["track-1"],
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          type: "visual",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    }));
  });

  it("does not recover live clips into a detached saved selection", () => {
    const savedClip = {
      id: "saved-clip",
      type: "video" as const,
      trackId: "saved-track",
      name: "Saved clip",
      assetId: "saved-asset",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      start: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      components: [
        {
          id: "mask-ref",
          type: "mask_ref" as const,
          parameters: { maskClipId: "live-mask" },
        },
      ],
    };

    expect(
      normalizeDetachedTimelineSelection({
        start: 0, end: 100,
        clips: [savedClip],
      }, 96000).region.clips,
    ).toEqual([savedClip]);
    expect(
      normalizeDetachedTimelineSelection({ start: 0, clips: [] }, 96000).region.clips,
    ).toEqual([]);
  });

  it("repairs a saved mask whose inherited speed transform was written as null", () => {
    const speed = {
      id: "speed",
      type: "speed" as const,
      isEnabled: true,
      parameters: { factor: 2 },
    };
    const position = {
      id: "mask:position",
      type: "position" as const,
      isEnabled: true,
      parameters: { x: 0, y: 0 },
    };
    const clipBase = {
      trackId: "track",
      sourceDuration: null,
      transformedDuration: 100,
      transformedOffset: 0,
      start: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
    };
    const parent = {
      ...clipBase,
      id: "parent",
      type: "image" as const,
      name: "Parent",
      assetId: "asset",
      transformations: [speed],
    };
    const mask = {
      ...clipBase,
      id: "parent::mask::mask",
      type: "mask" as const,
      name: "Mask",
      parentClipId: "parent",
      transformations: [position, null],
    };

    const clips = normalizeDetachedTimelineSelection({
      start: 0,
      clips: [parent, mask] as never,
    }, 96000).region.clips;

    expect(clips[0].transformations).toEqual(parent.transformations);
    expect(clips[1].transformations).toEqual([position, speed]);
  });

  it("preserves valid saved clips so metadata-backed transforms survive normalization", () => {
    const savedClip = {
      id: "saved-clip",
      type: "video" as const,
      name: "Saved Clip",
      assetId: "asset-1",
      sourceDuration: 300,
      transformedDuration: 300,
      transformedOffset: 40,
      timelineDuration: 120,
      croppedSourceDuration: 180,
      offset: 60,
      transformations: [
        {
          id: "speed-1",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 1.5 },
        },
      ],
      trackId: "track-1",
      start: 240,
    };
    const liveTimelineClip = {
      ...savedClip,
      id: "live-clip",
      transformedOffset: 0,
      croppedSourceDuration: 120,
      offset: 0,
      transformations: [],
    };

    expect(
      normalizeTimelineSelection(
        {
          start: 240,
          end: 360,
          clips: [savedClip],
          tracks: [
            {
              id: "track-1",
              label: "Track 1",
              type: "visual" as const,
              isVisible: true,
              isMuted: false,
              isLocked: false,
            },
          ],
        },
        [liveTimelineClip], 96000
      ),
    ).toEqual(makeTimelineSelection({
      start: 240,
      end: 360,
      clips: [savedClip],
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          type: "visual",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    }));
  });

  it("filters tracks and clips using included-track ids while preserving linked masks", () => {
    const visualTrack = {
      id: "track-visual",
      label: "Visual",
      type: "visual" as const,
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const audioTrack = {
      id: "track-audio",
      label: "Audio",
      type: "audio" as const,
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const maskTrack = {
      id: "track-mask",
      label: "Mask",
      type: "mask" as const,
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const visualClip = {
      id: "clip-visual",
      type: "video" as const,
      name: "Visual Clip",
      assetId: "asset-1",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-visual",
      start: 0,
      components: [
        {
          id: "mask-ref-1",
          type: "mask_ref" as const,
          parameters: {
            maskClipId: "clip-mask",
          },
        },
      ],
    };
    const maskClip = {
      id: "clip-mask",
      type: "mask" as const,
      name: "Mask Clip",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-mask",
      start: 0,
      maskType: "brush" as const,
      maskMode: "apply" as const,
      maskInverted: false,
      maskParameters: {
        baseWidth: 100,
        baseHeight: 100,
      },
    };
    const audioClip = {
      id: "clip-audio",
      type: "audio" as const,
      name: "Audio Clip",
      assetId: "asset-2",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-audio",
      start: 0,
    };

    const selection = makeTimelineSelection({
      start: 0,
      end: 100,
      clips: [visualClip, maskClip, audioClip],
      tracks: [visualTrack, audioTrack, maskTrack],
      includedTrackIds: ["track-visual"],
    });

    expect(getIncludedTracksForSelection(selection, selection.region.tracks ?? [])).toEqual([
      visualTrack,
    ]);
    expect(getIncludedClipsForSelection(selection, selection.region.clips)).toEqual([
      visualClip,
      maskClip,
    ]);
  });

  it("treats mask_ref-backed selections as masked even when the mask clip is absent", () => {
    const selection = makeTimelineSelection({
      start: 0,
      end: 100,
      clips: [
        {
          id: "clip-visual",
          type: "video" as const,
          name: "Visual Clip",
          assetId: "asset-1",
          sourceDuration: 100,
          transformedDuration: 100,
          transformedOffset: 0,
          timelineDuration: 100,
          croppedSourceDuration: 100,
          offset: 0,
          transformations: [],
          trackId: "track-visual",
          start: 0,
          components: [
            {
              id: "mask-ref-1",
              type: "mask_ref" as const,
              parameters: {
                maskClipId: "clip-mask",
              },
            },
          ],
        },
      ],
    });

    expect(selectionHasMaskClip(selection)).toBe(true);
  });

  it("recovers linked mask clips when saved selections only contain the parent clip", () => {
    const visualClip = {
      id: "clip-visual",
      type: "video" as const,
      name: "Visual Clip",
      assetId: "asset-1",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-visual",
      start: 0,
      components: [
        {
          id: "mask-ref-1",
          type: "mask_ref" as const,
          parameters: {
            maskClipId: "clip-mask",
          },
        },
      ],
    };
    const maskClip = {
      id: "clip-mask",
      type: "mask" as const,
      name: "Mask Clip",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformations: [],
      trackId: "track-mask",
      start: 0,
      maskType: "circle" as const,
      maskMode: "apply" as const,
      maskInverted: false,
      maskParameters: {
        baseWidth: 100,
        baseHeight: 100,
      },
    };

    expect(
      normalizeTimelineSelection(
        {
          start: 0,
          end: 100,
          clips: [visualClip],
        },
        [visualClip, maskClip], 96000
      ),
    ).toEqual(makeTimelineSelection({
      start: 0,
      end: 100,
      clips: [visualClip, maskClip],
    }));
  });

  it("creates a selection from clip ids and carries linked mask clips", () => {
    const visualTrack = {
      id: "track-visual",
      label: "Visual",
      type: "visual" as const,
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const maskTrack = {
      id: "track-mask",
      label: "Mask",
      type: "mask" as const,
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const visualClip = {
      id: "clip-visual",
      type: "video" as const,
      name: "Visual Clip",
      assetId: "asset-1",
      sourceDuration: 300,
      transformedDuration: 300,
      transformedOffset: 0,
      timelineDuration: TICKS_PER_SECOND,
      croppedSourceDuration: TICKS_PER_SECOND,
      offset: 0,
      transformations: [],
      trackId: "track-visual",
      start: TICKS_PER_SECOND,
      components: [
        {
          id: "mask-ref-1",
          type: "mask_ref" as const,
          parameters: {
            maskClipId: "clip-mask",
          },
        },
      ],
    };
    const maskClip = {
      id: "clip-mask",
      type: "mask" as const,
      name: "Mask Clip",
      sourceDuration: 100,
      transformedDuration: 100,
      transformedOffset: 0,
      timelineDuration: TICKS_PER_SECOND,
      croppedSourceDuration: TICKS_PER_SECOND,
      offset: 0,
      transformations: [],
      trackId: "track-mask",
      start: TICKS_PER_SECOND,
      maskType: "circle" as const,
      maskMode: "apply" as const,
      maskInverted: false,
      maskParameters: {
        baseWidth: 100,
        baseHeight: 100,
      },
    };

    const selection = createTimelineSelectionFromClipIds({
      clipIds: [visualClip.id],
      clips: [visualClip, maskClip],
      tracks: [visualTrack, maskTrack],
      fps: 24,
      frameStep: 4,
    });

    expect(selection).toEqual(makeTimelineSelection({
      start: TICKS_PER_SECOND,
      end: 2 * TICKS_PER_SECOND,
      aspectRatio: useProjectStore.getState().config.aspectRatio,
      clips: [visualClip, maskClip],
      tracks: [visualTrack, maskTrack],
      fps: 24,
      frameStep: 4,
    }, 30));
    expect(selection?.region.clips[0]).not.toBe(visualClip);
  });

  it("bounds a clip-id selection by presentation and bakes in its ripple context", () => {
    const track = (id: string, type: "visual" | "adjustment") => ({
      id, type, label: id, isVisible: true, isMuted: false, isLocked: false,
    });
    const ripple = {
      id: "ripple",
      type: "adjustment" as const,
      name: "Ripple",
      trackId: "track-adjustment",
      start: 0,
      timelineDuration: TICKS_PER_SECOND,
      sourceDuration: 2 * TICKS_PER_SECOND,
      croppedSourceDuration: 2 * TICKS_PER_SECOND,
      transformedDuration: TICKS_PER_SECOND,
      transformedOffset: 0,
      offset: 0,
      transformations: [
        { id: "speed", type: "speed" as const, isEnabled: true, parameters: { factor: 2 } },
      ],
      depth: 1,
      retimingMode: "ripple" as const,
    };
    const shifted = {
      id: "clip-shifted",
      type: "video" as const,
      name: "Shifted",
      assetId: "asset-1",
      trackId: "track-visual",
      start: 2 * TICKS_PER_SECOND,
      timelineDuration: TICKS_PER_SECOND,
      sourceDuration: TICKS_PER_SECOND,
      croppedSourceDuration: TICKS_PER_SECOND,
      transformedDuration: TICKS_PER_SECOND,
      transformedOffset: 0,
      offset: 0,
      transformations: [],
    };

    const selection = createTimelineSelectionFromClipIds({
      clipIds: [shifted.id],
      clips: [ripple, shifted],
      tracks: [track("track-adjustment", "adjustment"), track("track-visual", "visual")],
    });

    // Where the clip is shown, not where it is stored.
    expect(selection).toMatchObject({ anchor: TICKS_PER_SECOND, durationTicks: TICKS_PER_SECOND });
    expect(selection?.region.clips.map((clip) => clip.id)).toEqual([shifted.id]);
  });
});
