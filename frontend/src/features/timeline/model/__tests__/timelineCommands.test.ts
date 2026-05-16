import { describe, expect, it } from "vitest";
import type { TextTimelineClip } from "../../../../types/TimelineTypes";
import { withTimelineClipDefaults } from "../timelineCommands";

describe("withTimelineClipDefaults", () => {
  it("normalizes text clip data without requiring text fields on the shared clip type", () => {
    const clip = {
      id: "clip-text",
      type: "text",
      name: "",
      trackId: "track-1",
      start: 0,
      sourceDuration: null,
      timelineDuration: 90,
      croppedSourceDuration: 90,
      offset: 0,
      transformedDuration: 90,
      transformedOffset: 0,
      transformations: [],
      textData: {
        content: "  Hello world  ",
      },
    } as unknown as TextTimelineClip;

    const normalized = withTimelineClipDefaults(clip);

    expect(normalized.type).toBe("text");
    if (normalized.type !== "text") {
      throw new Error("Expected a text clip");
    }

    expect(normalized.name).toBe("Hello world");
    expect(normalized.textData).toMatchObject({
      content: "  Hello world  ",
      fontFamily: expect.any(String),
      fontSize: expect.any(Number),
      fill: expect.any(String),
      align: expect.any(String),
    });
  });
});
