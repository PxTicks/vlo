import { describe, expect, it } from "vitest";
import {
  getIncludedClipsForSelection,
  getIncludedTracksForSelection,
  getTicksPerFrame,
  normalizeTimelineSelection,
  resolveSelectionFps,
  resolveSelectionFrameStep,
  snapFrameCountToStep,
} from "../timelineSelection";
import { TICKS_PER_SECOND } from "../../../timeline";

describe("timelineSelection helpers", () => {
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
        [timelineClip],
      ),
    ).toEqual({
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
    });
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

    const selection = {
      start: 0,
      end: 100,
      clips: [visualClip, maskClip, audioClip],
      tracks: [visualTrack, audioTrack, maskTrack],
      includedTrackIds: ["track-visual"],
    };

    expect(getIncludedTracksForSelection(selection, selection.tracks)).toEqual([
      visualTrack,
    ]);
    expect(getIncludedClipsForSelection(selection, selection.clips)).toEqual([
      visualClip,
      maskClip,
    ]);
  });
});
