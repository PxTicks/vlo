import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { useTimelineStore } from "../useTimelineStore";

function createTextClip(
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id: "clip_text_1",
    trackId: "track_1",
    type: "text",
    name: "Old Name",
    sourceDuration: null,
    start: 0,
    timelineDuration: 150,
    offset: 0,
    transformedDuration: 150,
    transformedOffset: 0,
    croppedSourceDuration: 150,
    transformations: [],
    textData: {
      content: "Hello world",
      fontFamily: "Arial",
      fontSize: 96,
      fill: "#ffffff",
      align: "center",
      strokeColor: "#000000",
      strokeWidth: 2,
    },
    ...overrides,
  } as TimelineClip;
}

describe("useTimelineStore text clip updates", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
          type: "visual",
        },
      ],
      clips: [createTextClip()],
    });
  });

  it("updates text clip styling and keeps the clip name in sync with the content", () => {
    useTimelineStore.getState().updateTextClipData("clip_text_1", {
      content: "Updated title\nSecond line",
      fontFamily: "Georgia",
      fontSize: 72,
      fill: "#ff8800",
      align: "right",
    });

    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        id: "clip_text_1",
        name: "Updated title",
        textData: {
          content: "Updated title\nSecond line",
          fontFamily: "Georgia",
          fontSize: 72,
          fill: "#ff8800",
          align: "right",
          strokeColor: "#000000",
          strokeWidth: 2,
        },
      }),
    ]);
  });

  it("ignores text updates for non-text clips", () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "track_1",
          label: "Track 1",
          isVisible: true,
          isMuted: false,
          isLocked: false,
          type: "visual",
        },
      ],
      clips: [
        {
          id: "clip_video_1",
          trackId: "track_1",
          type: "video",
          name: "Video",
          assetId: "asset_1",
          sourceDuration: 150,
          start: 0,
          timelineDuration: 150,
          offset: 0,
          transformedDuration: 150,
          transformedOffset: 0,
          croppedSourceDuration: 150,
          transformations: [],
        } as TimelineClip,
      ],
    });

    useTimelineStore.getState().updateTextClipData("clip_video_1", {
      content: "Should not apply",
    });

    expect(useTimelineStore.getState().clips[0]).toMatchObject({
      id: "clip_video_1",
      type: "video",
      name: "Video",
    });
  });
});
