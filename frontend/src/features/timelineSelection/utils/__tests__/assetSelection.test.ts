import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { TimelineClip } from "../../../../types/TimelineTypes";

const liveClip = {
  id: "live-clip",
  trackId: "live-track",
  type: "video",
  name: "Live clip",
  assetId: "live-asset",
  sourceDuration: 100,
  transformedDuration: 100,
  transformedOffset: 0,
  timelineDuration: 100,
  croppedSourceDuration: 100,
  offset: 0,
  transformations: [],
  start: 0,
} satisfies TimelineClip;

const mockGetTimelineClips = vi.hoisted(() => vi.fn());

vi.mock("../../../timeline/api", () => ({
  getTimelineClips: mockGetTimelineClips,
}));

import { getTimelineSelectionFromAsset } from "../assetSelection";

function createGeneratedAsset(clips: TimelineClip[]): Asset {
  return {
    id: "generated-asset",
    hash: "hash",
    name: "generated.mp4",
    type: "video",
    src: "generated.mp4",
    createdAt: 1,
    creationMetadata: {
      source: "generated",
      workflowName: "Test workflow",
      inputs: [
        {
          nodeId: "input-node",
          kind: "timelineSelection",
          timelineSelection: {
            start: 0,
            end: 100,
            clips,
          },
        },
      ],
    },
  };
}

describe("getTimelineSelectionFromAsset", () => {
  beforeEach(() => {
    mockGetTimelineClips.mockReset();
    mockGetTimelineClips.mockReturnValue([liveClip]);
  });

  it("keeps an empty saved snapshot empty instead of filling it from the live timeline", () => {
    expect(getTimelineSelectionFromAsset(createGeneratedAsset([]))?.clips).toEqual(
      [],
    );
  });

  it("preserves saved clips instead of replacing them by live id", () => {
    const savedClip = {
      ...liveClip,
      name: "Saved clip",
      transformedOffset: 24,
    };

    expect(
      getTimelineSelectionFromAsset(createGeneratedAsset([savedClip]))?.clips,
    ).toEqual([savedClip]);
  });
});
