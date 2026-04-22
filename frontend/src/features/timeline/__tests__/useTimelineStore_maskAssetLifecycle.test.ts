import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";

const { mockDeleteAsset } = vi.hoisted(() => ({
  mockDeleteAsset: vi.fn(async () => undefined),
}));

vi.mock("../../userAssets", () => ({
  deleteAsset: mockDeleteAsset,
}));

import { useTimelineStore } from "../useTimelineStore";

const createTrack = (id: string, label: string): TimelineTrack => ({
  id,
  label,
  isVisible: true,
  isLocked: false,
  isMuted: false,
});

const createParentClip = (
  id: string,
  trackId: string,
  maskClipId?: string,
): StandardTimelineClip => ({
    id,
    trackId,
    type: "video",
    name: id,
    assetId: `${id}-asset`,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    croppedSourceDuration: 120,
    transformedOffset: 0,
    sourceDuration: 120,
    transformedDuration: 120,
    transformations: [],
    clipComponents: maskClipId
      ? [
          {
            clipId: maskClipId,
            componentType: "mask",
          },
        ]
      : [],
  });

const createSam2MaskClip = (
  parentClipId: string,
  maskLocalId: string,
  trackId: string,
  sam2MaskAssetId: string,
): MaskTimelineClip => ({
    id: `${parentClipId}::mask::${maskLocalId}`,
    trackId,
    type: "mask",
    name: `Mask ${maskLocalId}`,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    croppedSourceDuration: 120,
    transformedOffset: 0,
    sourceDuration: 120,
    transformedDuration: 120,
    transformations: [],
    parentClipId,
    maskType: "sam2",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    sam2MaskAssetId,
  });

describe("useTimelineStore SAM2 mask asset lifecycle", () => {
  beforeEach(() => {
    mockDeleteAsset.mockClear();
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [],
    });
  });

  it("deletes child SAM2 mask assets when a parent clip is removed", async () => {
    const parentClipId = "clip-1";
    const maskLocalId = "mask-1";
    const maskClipId = `${parentClipId}::mask::${maskLocalId}`;
    const maskAssetId = "sam2-mask-asset-1";

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [
        createParentClip(parentClipId, "track_current", maskClipId),
        createSam2MaskClip(
          parentClipId,
          maskLocalId,
          "track_current",
          maskAssetId,
        ),
      ],
    });

    act(() => {
      useTimelineStore.getState().removeClip(parentClipId);
    });

    expect(useTimelineStore.getState().clips).toHaveLength(0);

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith(maskAssetId);
    });
    expect(mockDeleteAsset).toHaveBeenCalledTimes(1);
  });

  it("deletes linked SAM2 mask assets when a mask is removed", async () => {
    const parentClipId = "clip-2";
    const maskLocalId = "mask-2";
    const maskClipId = `${parentClipId}::mask::${maskLocalId}`;
    const maskAssetId = "sam2-mask-asset-2";

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [
        createParentClip(parentClipId, "track_current", maskClipId),
        createSam2MaskClip(
          parentClipId,
          maskLocalId,
          "track_current",
          maskAssetId,
        ),
      ],
    });

    act(() => {
      useTimelineStore.getState().removeClipMask(parentClipId, maskLocalId);
    });

    const remainingClips = useTimelineStore.getState().clips;
    expect(remainingClips).toHaveLength(1);
    expect(remainingClips[0].id).toBe(parentClipId);

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith(maskAssetId);
    });
    expect(mockDeleteAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared SAM2 mask asset when removing one duplicated mask", async () => {
    const sharedAssetId = "sam2-mask-shared";

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [
        createParentClip("clip-a", "track_current", "clip-a::mask::mask-1"),
        createSam2MaskClip("clip-a", "mask-1", "track_current", sharedAssetId),
        createParentClip("clip-b", "track_current", "clip-b::mask::mask-1"),
        createSam2MaskClip("clip-b", "mask-1", "track_current", sharedAssetId),
      ],
    });

    act(() => {
      useTimelineStore.getState().removeClipMask("clip-a", "mask-1");
    });

    const remainingClips = useTimelineStore.getState().clips;
    expect(remainingClips.map((clip) => clip.id)).toEqual([
      "clip-a",
      "clip-b",
      "clip-b::mask::mask-1",
    ]);

    await waitFor(() => {
      expect(mockDeleteAsset).not.toHaveBeenCalled();
    });
  });

  it("keeps a shared SAM2 mask asset when removing one duplicated parent clip", async () => {
    const sharedAssetId = "sam2-mask-shared-parent";

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [
        createParentClip("clip-a", "track_current", "clip-a::mask::mask-1"),
        createSam2MaskClip("clip-a", "mask-1", "track_current", sharedAssetId),
        createParentClip("clip-b", "track_current", "clip-b::mask::mask-1"),
        createSam2MaskClip("clip-b", "mask-1", "track_current", sharedAssetId),
      ],
    });

    act(() => {
      useTimelineStore.getState().removeClip("clip-a");
    });

    const remainingClips = useTimelineStore.getState().clips;
    expect(remainingClips.map((clip) => clip.id)).toEqual([
      "clip-b",
      "clip-b::mask::mask-1",
    ]);

    await waitFor(() => {
      expect(mockDeleteAsset).not.toHaveBeenCalled();
    });
  });

  it("removes timeline clips by asset id and deletes child SAM2 mask assets", async () => {
    const parentClipId = "clip-3";
    const maskLocalId = "mask-3";
    const maskClipId = `${parentClipId}::mask::${maskLocalId}`;
    const maskAssetId = "sam2-mask-asset-3";

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        createTrack("track_top_pad", "Track 1"),
        createTrack("track_current", "Track 2"),
        createTrack("track_bottom_pad", "Track 3"),
      ],
      clips: [
        createParentClip(parentClipId, "track_current", maskClipId),
        createSam2MaskClip(
          parentClipId,
          maskLocalId,
          "track_current",
          maskAssetId,
        ),
        {
          ...createParentClip("clip-4", "track_current"),
          assetId: "other-asset",
        },
      ],
    });

    const removedCount = useTimelineStore
      .getState()
      .removeClipsByAssetId(`${parentClipId}-asset`);

    expect(removedCount).toBe(1);
    const remainingClips = useTimelineStore.getState().clips;
    expect(remainingClips).toHaveLength(1);
    expect(remainingClips[0].id).toBe("clip-4");

    await waitFor(() => {
      expect(mockDeleteAsset).toHaveBeenCalledWith(maskAssetId);
    });
    expect(mockDeleteAsset).toHaveBeenCalledTimes(1);
  });
});
