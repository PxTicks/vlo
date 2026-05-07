import { describe, expect, it } from "vitest";

import type { TimelineSelection } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline";
import { buildWorkflowInputMetadataMap } from "../inputMetadata";

function createSelection(
  overrides: Partial<TimelineSelection> = {},
): TimelineSelection {
  return {
    start: 0,
    end: 4 * TICKS_PER_SECOND,
    clips: [],
    tracks: [
      {
        id: "track-1",
        label: "Track 1",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    ],
    fps: 24,
    frameStep: 1,
    ...overrides,
  };
}

describe("buildWorkflowInputMetadataMap", () => {
  it("builds aliased metadata for timeline selections", () => {
    const selection = createSelection();
    const metadata = buildWorkflowInputMetadataMap(
      [
        {
          id: "video_input",
          nodeId: "89",
          classType: "LoadVideo",
          inputType: "video",
          param: "video",
          label: "Video",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        video_input: {
          kind: "timelineSelection",
          mediaType: "video",
          timelineSelection: selection,
          thumbnailFile: new File(["thumb"], "thumb.png", { type: "image/png" }),
          thumbnailUrl: "blob://thumb",
          isExtracting: false,
          extractionRequestId: 1,
          extractionError: null,
          preparedVideoFile: null,
          preparedMaskFile: null,
        },
      },
      {
        fps: 30,
        aspectRatio: "16:9",
      },
    );

    expect(metadata.video_input).toEqual(metadata["89"]);
    expect(metadata.video_input).toMatchObject({
      sourceKind: "timeline_selection",
      inputType: "video",
      mediaType: "video",
      timelineSelection: {
        durationSeconds: 4,
        frameCount: 96,
        effectiveFps: 24,
      },
    });
  });

  it("preserves frame-source metadata for timeline-derived image inputs", () => {
    const metadata = buildWorkflowInputMetadataMap(
      [
        {
          nodeId: "167",
          classType: "LoadImage",
          inputType: "image",
          param: "image",
          label: "Frame",
          currentValue: null,
          origin: "rule",
        },
      ],
      {
        "167": {
          kind: "frame",
          file: new File(["frame"], "frame.png", { type: "image/png" }),
          previewUrl: "blob://frame",
          timelineSelection: createSelection({ end: TICKS_PER_SECOND }),
        },
      },
      {
        fps: 24,
        aspectRatio: "16:9",
      },
    );

    expect(metadata["167"]).toMatchObject({
      sourceKind: "frame",
      inputType: "image",
      mediaType: "image",
      timelineSelection: {
        durationSeconds: 1,
        frameCount: 24,
      },
    });
  });
});
