import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Asset, AssetFamily } from "../../../../types/Asset";
import type { StandardTimelineClip } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND, useTimelineStore } from "../../../timeline";
import { useAssetBrowserRevealStore } from "../../useAssetBrowserRevealStore";
import { useAssetStore } from "../../useAssetStore";
import { useTimelineAssetRevealClipOverlay } from "../useTimelineAssetRevealClipOverlay";

const baseClip: StandardTimelineClip = {
  id: "clip-1",
  trackId: "track-1",
  start: 0,
  type: "video",
  assetId: "asset-1",
  name: "Clip 1",
  sourceDuration: 10 * TICKS_PER_SECOND,
  transformedDuration: 10 * TICKS_PER_SECOND,
  transformedOffset: 0,
  timelineDuration: 10 * TICKS_PER_SECOND,
  croppedSourceDuration: 10 * TICKS_PER_SECOND,
  offset: 0,
  transformations: [],
};

const familyAssets: Asset[] = [
  {
    id: "asset-1",
    type: "video",
    name: "Newest.mp4",
    src: "newest.mp4",
    hash: "hash-1",
    familyId: "family-1",
    duration: 10,
    fps: 24,
    createdAt: 300,
  },
  {
    id: "asset-2",
    type: "video",
    name: "Middle.mp4",
    src: "middle.mp4",
    hash: "hash-2",
    familyId: "family-1",
    duration: 10,
    fps: 24,
    createdAt: 200,
  },
  {
    id: "asset-3",
    type: "video",
    name: "Oldest.mp4",
    src: "oldest.mp4",
    hash: "hash-3",
    familyId: "family-1",
    duration: 10,
    fps: 24,
    createdAt: 100,
  },
];

const families: AssetFamily[] = [
  {
    id: "family-1",
    representativeAssetId: "asset-1",
    autoMatchKeys: ["generation-family:v1:test"],
    compatibility: {
      assetType: "video",
      durationMs: 10000,
      fpsMilli: 24000,
    },
    createdAt: 100,
    updatedAt: 300,
  },
];

function useOverlayItems(clip: StandardTimelineClip) {
  const overlay = useTimelineAssetRevealClipOverlay();
  return overlay.useItems({ clip, isSelected: false });
}

describe("useTimelineAssetRevealClipOverlay", () => {
  beforeEach(() => {
    useAssetBrowserRevealStore.setState({ revealRequest: null });
    useAssetStore.setState({
      assets: familyAssets,
      families,
    });
    useTimelineStore.setState({
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
          type: "visual",
        },
      ],
      clips: [baseClip],
      selectedClipIds: [],
      copiedClips: [],
    });
  });

  it("creates family navigation arrows around the reveal control and swaps the clip asset", () => {
    const { result, rerender } = renderHook(
      ({ clip }: { clip: StandardTimelineClip }) => useOverlayItems(clip),
      {
        initialProps: {
          clip: baseClip,
        } as { clip: StandardTimelineClip },
      },
    );

    expect(result.current).toHaveLength(3);
    expect(result.current.map((item) => item.id)).toEqual([
      "reveal-asset:clip-1",
      "swap-family-next:clip-1",
      "swap-family-previous:clip-1",
    ]);
    expect(result.current[0].placement).toMatchObject({
      kind: "endpoint",
      edge: "end",
      lane: "bottom",
      insetPx: 8,
      order: 1,
    });

    result.current[0].onClick?.();

    expect(useAssetBrowserRevealStore.getState().revealRequest).toMatchObject({
      assetId: "asset-1",
      requestId: expect.any(Number),
    });

    result.current[1].onClick?.();
    expect(useTimelineStore.getState().clips[0]).toMatchObject({
      assetId: "asset-2",
      name: "Middle.mp4",
    });

    rerender({
      clip: useTimelineStore.getState().clips[0] as StandardTimelineClip,
    });
    result.current[2].onClick?.();
    expect(useTimelineStore.getState().clips[0]).toMatchObject({
      assetId: "asset-1",
      name: "Newest.mp4",
    });
  });

  it("omits the reveal overlay for clips that do not reference an asset", () => {
    const { result } = renderHook(() =>
      useOverlayItems({ ...baseClip, assetId: undefined as unknown as string }),
    );

    expect(result.current).toEqual([]);
  });

  it("renders only the shifted reveal icon when the clip asset has no family siblings", () => {
    useAssetStore.setState({
      assets: [{ ...familyAssets[0], familyId: undefined }],
      families: [],
    });

    const { result } = renderHook(() =>
      useOverlayItems({ ...baseClip, assetId: "asset-1" }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].placement).toMatchObject({
      kind: "endpoint",
      edge: "end",
      lane: "bottom",
      insetPx: 28,
      order: 0,
    });
  });
});
