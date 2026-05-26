import { describe, expect, it } from "vitest";
import type {
  AdjustmentTimelineClip,
  TextTimelineClip,
} from "../../../../types/TimelineTypes";
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

  it("does not inject a default fitMode transform on adjustment clips", () => {
    // Adjustment clips have no visual content of their own — the fitMode
    // default is meaningless for them. Pinning this so a later broadening of
    // visual defaults (e.g. adding "shape" or "text" to the fitMode branch)
    // doesn't accidentally sweep adjustments in too.
    const clip = {
      id: "adj-1",
      type: "adjustment",
      name: "Color",
      trackId: "track-adj",
      start: 0,
      sourceDuration: null,
      timelineDuration: 100,
      croppedSourceDuration: 100,
      offset: 0,
      transformedDuration: 100,
      transformedOffset: 0,
      transformations: [],
      depth: 2,
    } as unknown as AdjustmentTimelineClip;

    const normalized = withTimelineClipDefaults(clip);

    expect(normalized.type).toBe("adjustment");
    expect(normalized.transformations).toEqual([]);
  });
});
