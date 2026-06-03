import { describe, expect, it } from "vitest";
import { createCompositeTimelineClip } from "../createCompositeClip";

describe("createCompositeTimelineClip", () => {
  it("prefers the baked proxy duration when provided", () => {
    const clip = createCompositeTimelineClip({
      content: {
        durationTicks: 100,
        clips: [],
      },
      trackId: "track-1",
      start: 0,
      proxyDurationTicks: 120,
    });

    expect(clip).toMatchObject({
      sourceDuration: 120,
      timelineDuration: 120,
      croppedSourceDuration: 120,
      transformedDuration: 120,
    });
  });
});
