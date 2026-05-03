import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrushPaintedBounds,
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";

const {
  mockDisposeBrushBuffer,
  mockExtractBrushPng,
  mockGetBrushBuffer,
  mockIsBrushBufferDirty,
  mockMarkBrushBufferClean,
  mockAddLocalAsset,
  mockDeleteAsset,
} = vi.hoisted(() => ({
  mockDisposeBrushBuffer: vi.fn(),
  mockExtractBrushPng: vi.fn(),
  mockGetBrushBuffer: vi.fn(),
  mockIsBrushBufferDirty: vi.fn(),
  mockMarkBrushBufferClean: vi.fn(),
  mockAddLocalAsset: vi.fn(),
  mockDeleteAsset: vi.fn(),
}));

vi.mock("../brushBufferRegistry", () => ({
  disposeBrushBuffer: mockDisposeBrushBuffer,
  extractBrushPng: mockExtractBrushPng,
  getBrushBuffer: mockGetBrushBuffer,
  isBrushBufferDirty: mockIsBrushBufferDirty,
  markBrushBufferClean: mockMarkBrushBufferClean,
}));

import { useTimelineStore } from "../../../timeline";
import { useAssetStore } from "../../../userAssets";
import { commitBrushMaskAsset, flushBrushMaskCommit } from "../brushAssetSync";

const createTrack = (id: string): TimelineTrack => ({
  id,
  label: id,
  isVisible: true,
  isLocked: false,
  isMuted: false,
  type: "visual",
});

function createParentClip(maskClipId: string): StandardTimelineClip {
  return {
    id: "clip_1",
    trackId: "track_1",
    type: "video",
    name: "Parent clip",
    assetId: "asset_1",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    components: [
      {
        id: "mask_ref_1",
        type: "mask_ref",
        parameters: { maskClipId },
      },
    ],
  };
}

function createBrushMaskClip(
  assetId?: string,
  paintedBounds?: BrushPaintedBounds,
): MaskTimelineClip {
  return {
    id: "clip_1::mask::mask_1",
    trackId: "track_1",
    type: "mask",
    name: "Brush mask",
    sourceDuration: 120,
    start: 0,
    timelineDuration: 120,
    offset: 0,
    transformedDuration: 120,
    transformedOffset: 0,
    croppedSourceDuration: 120,
    transformations: [],
    parentClipId: "clip_1",
    maskType: "brush",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
    brushMaskAssetId: assetId,
    brushPaintedBounds: paintedBounds,
  };
}

describe("brushAssetSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [],
    });
    useAssetStore.setState({
      assets: [],
      addLocalAsset: mockAddLocalAsset,
      deleteAsset: mockDeleteAsset,
    });
  });

  it("clears persisted brush metadata when the buffer is empty", async () => {
    const persistedBounds = { x: 10, y: 12, width: 50, height: 60 };
    const brushMask = createBrushMaskClip("brush-asset-1", persistedBounds);

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [createParentClip(brushMask.id), brushMask],
    });

    const result = await commitBrushMaskAsset(
      "clip_1",
      brushMask.id,
      "mask_1",
      "brush-asset-1",
      null,
    );

    expect(result).toBeNull();
    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip): clip is MaskTimelineClip => clip.id === brushMask.id);
    expect(updatedMask?.brushMaskAssetId).toBeUndefined();
    expect(updatedMask?.brushPaintedBounds).toBeUndefined();
    expect(mockDeleteAsset).toHaveBeenCalledWith("brush-asset-1");
    expect(mockAddLocalAsset).not.toHaveBeenCalled();
  });

  it("does not create an orphan asset when flushing a deleted brush mask", async () => {
    mockIsBrushBufferDirty.mockReturnValue(true);
    mockGetBrushBuffer.mockReturnValue({
      paintedBounds: { x: 1, y: 2, width: 30, height: 40 },
    });

    await flushBrushMaskCommit("clip_deleted::mask::mask_brush");

    expect(mockAddLocalAsset).not.toHaveBeenCalled();
    expect(mockDeleteAsset).not.toHaveBeenCalled();
    expect(mockDisposeBrushBuffer).toHaveBeenCalledWith(
      "clip_deleted::mask::mask_brush",
    );
    expect(mockMarkBrushBufferClean).not.toHaveBeenCalled();
  });
});
