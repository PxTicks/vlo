import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";
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

import {
  getTimelineSelectionFromAsset,
  getTimelineSelectionStartFromAsset,
} from "../assetSelection";

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
          timelineSelection: makeTimelineSelection({
            start: 0,
            end: 100,
            clips,
          }),
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
    expect(getTimelineSelectionFromAsset(createGeneratedAsset([]))?.region.clips).toEqual(
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
      getTimelineSelectionFromAsset(createGeneratedAsset([savedClip]))?.region.clips,
    ).toEqual([savedClip]);
  });
});

describe("getTimelineSelectionStartFromAsset", () => {
  it("reads the start from a hydrated selection", () => {
    expect(
      getTimelineSelectionStartFromAsset(createGeneratedAsset([])),
    ).toBe(0);
  });

  it("reads the start from the abridged index copy", () => {
    // The asset index strips selection bodies, so "Send to Timeline" has to
    // survive on the retained start tick alone.
    const abridged: Asset = {
      ...createGeneratedAsset([]),
      metadataRef: "asset-metadata/generated-asset.json",
      metadataLoaded: false,
      creationMetadata: {
        source: "generated",
        workflowName: "Test workflow",
        inputs: [
          {
            nodeId: "input-node",
            kind: "timelineSelection",
            timelineSelectionStart: 96,
          },
        ],
      },
    };

    expect(getTimelineSelectionFromAsset(abridged)).toBeNull();
    expect(getTimelineSelectionStartFromAsset(abridged)).toBe(96);
  });

  // A video inpaint fed first/last-frame guides lists the frame slots ahead of
  // the video slot; the output spans the video, so the range must place it.
  function createFrameAndRangeAsset(): Asset {
    return {
      ...createGeneratedAsset([]),
      creationMetadata: {
        source: "generated",
        workflowName: "Test workflow",
        inputs: [
          {
            nodeId: "last-frame-node",
            kind: "timelineSelection",
            isFrame: true,
            timelineSelection: makeTimelineSelection({ start: 196, clips: [] }),
          },
          {
            nodeId: "video-node",
            kind: "timelineSelection",
            timelineSelection: makeTimelineSelection({ start: 100, end: 200, clips: [] }),
          },
        ],
      },
    };
  }

  it("prefers a range input over an earlier frame input", () => {
    const asset = createFrameAndRangeAsset();

    expect(getTimelineSelectionStartFromAsset(asset)).toBe(100);
    expect(getTimelineSelectionFromAsset(asset)?.anchor).toBe(100);
  });

  it("prefers the range on the abridged index copy", () => {
    expect(
      getTimelineSelectionStartFromAsset({
        ...createGeneratedAsset([]),
        creationMetadata: {
          source: "generated",
          workflowName: "Test workflow",
          inputs: [
            { nodeId: "last-frame-node", kind: "timelineSelection", isFrame: true, timelineSelectionStart: 196 },
            { nodeId: "video-node", kind: "timelineSelection", timelineSelectionStart: 100 },
          ],
        },
      }),
    ).toBe(100);
  });

  it("recognises frames recorded before the flag from the hydrated point selection", () => {
    const asset = createFrameAndRangeAsset();
    if (asset.creationMetadata?.source !== "generated") throw new Error("Expected generated metadata");
    const [frame] = asset.creationMetadata.inputs;
    if (frame?.kind !== "timelineSelection") throw new Error("Expected a selection input");
    delete frame.isFrame;

    expect(getTimelineSelectionStartFromAsset(asset)).toBe(100);
  });

  it("falls back to a frame input when the workflow took no range", () => {
    expect(
      getTimelineSelectionStartFromAsset({
        ...createGeneratedAsset([]),
        creationMetadata: {
          source: "generated",
          workflowName: "Test workflow",
          inputs: [
            { nodeId: "first-frame-node", kind: "timelineSelection", isFrame: true, timelineSelectionStart: 48 },
          ],
        },
      }),
    ).toBe(48);
  });

  it("reads the start from an abridged extracted asset", () => {
    expect(
      getTimelineSelectionStartFromAsset({
        ...createGeneratedAsset([]),
        creationMetadata: { source: "extracted", timelineSelectionStart: 12 },
      }),
    ).toBe(12);
  });

  it("answers null when the asset has no selection", () => {
    expect(
      getTimelineSelectionStartFromAsset({
        ...createGeneratedAsset([]),
        creationMetadata: { source: "uploaded" },
      }),
    ).toBeNull();
  });
});
