import { describe, expect, it } from "vitest";
import type {
  ExtensionAssetApi,
  ExtensionTimelineApi,
  ExtensionTimelineClipSnapshot,
  ExtensionTimelineMaskSnapshot,
} from "../../../extensions/types";
import { createPositionPathFromMaskTracking } from "../maskTracking";

function createClip(): ExtensionTimelineClipSnapshot {
  return {
    id: "clip_1",
    type: "video",
    name: "Clip",
    trackId: "track_1",
    startTicks: 0,
    durationTicks: 100,
    assetId: "asset_1",
    transformations: [],
  };
}

function createMovingMask(): ExtensionTimelineMaskSnapshot {
  return {
    id: "clip_1::mask::mask_1",
    parentClipId: "clip_1",
    localId: "mask_1",
    name: "Mask",
    startTicks: 0,
    durationTicks: 100,
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    parameters: { baseWidth: 20, baseHeight: 10 },
    transformations: [
      {
        id: "position_1",
        type: "position",
        isEnabled: true,
        parameters: {
          x: {
            type: "spline",
            points: [
              { time: 0, value: 0 },
              { time: 100, value: 100 },
            ],
          },
          y: 0,
        },
      },
    ],
  };
}

function createTimelineApi(
  clip: ExtensionTimelineClipSnapshot,
): Pick<
  ExtensionTimelineApi,
  | "ticksPerSecond"
  | "listClips"
  | "clipProgressToSourceTicks"
  | "sourcePointToProject"
> {
  return {
    ticksPerSecond: 100,
    listClips: () => [clip],
    clipProgressToSourceTicks: (_clipId, progress) => progress * clip.durationTicks,
    sourcePointToProject: (point, source) => ({
      x: point.x - source.width / 2,
      y: point.y - source.height / 2,
    }),
  };
}

function createAssetApi(): Pick<ExtensionAssetApi, "get" | "readBlob"> {
  return {
    get: () => undefined,
    readBlob: async () => new Blob(),
  };
}

describe("maskTracking", () => {
  it("turns mask centroid motion into a stabilizing clip path", async () => {
    const clip = createClip();
    const path = await createPositionPathFromMaskTracking({
      timeline: createTimelineApi(clip),
      assets: createAssetApi(),
      clipId: clip.id,
      mask: createMovingMask(),
      tracking: { sampleCount: 5 },
    });

    expect(path?.controlPoints[0]).toEqual({ x: 0, y: 0 });
    expect(path?.controlPoints.at(-1)?.x).toBeCloseTo(-100);
    expect(path?.controlPoints.at(-1)?.y).toBeCloseTo(0);
  });
});
