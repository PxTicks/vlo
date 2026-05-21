import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompositeTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../types/TimelineTypes";

const { mockDeleteAsset } = vi.hoisted(() => ({
  mockDeleteAsset: vi.fn(async () => undefined),
}));

vi.mock("../../userAssets", () => ({
  deleteAsset: mockDeleteAsset,
}));

import { useTimelineStore } from "../useTimelineStore";

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  type: "visual",
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

function nestedVideoClip(id: string): VideoTimelineClip {
  return {
    id,
    trackId: "track-1",
    type: "video",
    name: id,
    assetId: `asset-${id}`,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
  };
}

function compositeClip(
  id: string,
  proxyAssetId: string,
): CompositeTimelineClip {
  return {
    id,
    trackId: "track-1",
    type: "composite",
    name: id,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    croppedSourceDuration: 100,
    transformedOffset: 0,
    sourceDuration: 100,
    transformedDuration: 100,
    transformations: [],
    proxyAssetId,
    proxyContentHash: `hash-${id}`,
    content: {
      durationTicks: 100,
      clips: [nestedVideoClip(`nested-${id}`)],
    },
  };
}

describe("useTimelineStore composite proxy lifecycle", () => {
  beforeEach(() => {
    mockDeleteAsset.mockClear();
    act(() => {
      useTimelineStore.getState().replaceTimelineSnapshot({
        tracks: [createTrack("track-1")],
        clips: [],
      });
    });
  });

  it("deletes an owned proxy asset when its composite clip is removed", async () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositeClip("composite-1", "proxy-1"));
      useTimelineStore.getState().removeClip("composite-1");
    });

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith("proxy-1");
    });
  });

  it("removes a composite that references a deleted proxy without recursing", () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositeClip("composite-1", "proxy-1"));
      expect(useTimelineStore.getState().removeClipsByAssetId("proxy-1")).toBe(1);
    });

    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(mockDeleteAsset).not.toHaveBeenCalledWith("proxy-1");
  });

  it("cleans up an old proxy after rebaking to a new proxy", async () => {
    act(() => {
      useTimelineStore
        .getState()
        .addClip(compositeClip("composite-1", "proxy-old"));
      useTimelineStore
        .getState()
        .setCompositeProxy("composite-1", "proxy-new", "fresh");
    });

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith("proxy-old");
    });
  });
});
