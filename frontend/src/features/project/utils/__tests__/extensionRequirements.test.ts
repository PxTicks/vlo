import { describe, expect, it } from "vitest";
import type { ExtensionTimelineClip } from "../../../../types/TimelineTypes";
import { collectTimelineExtensionRequirements } from "../extensionRequirements";

function extensionClip(
  id: string,
  schemaVersion: number,
): ExtensionTimelineClip {
  return {
    id,
    type: "extension",
    trackId: "track-1",
    name: "Unknown extension entity",
    sourceDuration: null,
    transformedDuration: 100,
    transformedOffset: 0,
    timelineDuration: 100,
    croppedSourceDuration: 100,
    offset: 0,
    start: 0,
    transformations: [],
    extensionPayload: {
      extensionId: "example.unknown",
      typeId: "shape",
      schemaVersion,
      data: { preserved: true },
    },
  };
}

describe("collectTimelineExtensionRequirements", () => {
  it("derives project requirements from extension entity envelopes", () => {
    const requirements = collectTimelineExtensionRequirements([
      extensionClip("clip-2", 2),
      extensionClip("clip-1", 1),
    ]);

    expect(requirements).toEqual([
      {
        id: "example.unknown/shape",
        extensionId: "example.unknown",
        typeId: "shape",
        schemaVersions: [1, 2],
        entityIds: ["clip-1", "clip-2"],
        availability: "missing",
      },
    ]);
  });
});
