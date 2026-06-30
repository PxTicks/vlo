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

  it("discovers animation providers nested in transformation parameters", () => {
    const clip = extensionClip("clip-animation", 1);
    clip.transformations = [
      {
        id: "position-1",
        type: "position",
        isEnabled: true,
        parameters: {
          x: {
            type: "extension-scalar",
            source: {
              extensionId: "example.math",
              typeId: "expression",
              schemaVersion: 2,
              data: { expression: "time" },
            },
          },
          y: 0,
          extensionPath: {
            type: "extension-path2d",
            geometry: {
              extensionId: "example.geometry",
              typeId: "orbit",
              schemaVersion: 1,
              data: { radius: 10 },
            },
            timing: {
              type: "extension-keyframed-scalar",
              keyframes: [
                {
                  time: 0,
                  value: 0,
                  outgoing: {
                    extensionId: "example.math",
                    typeId: "easing",
                    schemaVersion: 3,
                    data: null,
                  },
                },
                { time: 1, value: 1 },
              ],
            },
          },
        },
      },
    ];

    expect(
      collectTimelineExtensionRequirements([clip]).map((requirement) => ({
        id: requirement.id,
        availability: requirement.availability,
      })),
    ).toEqual([
      { id: "example.geometry/orbit", availability: "missing" },
      { id: "example.math/easing", availability: "missing" },
      { id: "example.math/expression", availability: "missing" },
      { id: "example.unknown/shape", availability: "missing" },
    ]);
  });
});
