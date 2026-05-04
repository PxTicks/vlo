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
  mockRecalculateBrushPaintedBounds,
  mockAddLocalAsset,
  mockDeleteAsset,
} = vi.hoisted(() => ({
  mockDisposeBrushBuffer: vi.fn(),
  mockExtractBrushPng: vi.fn(),
  mockGetBrushBuffer: vi.fn(),
  mockIsBrushBufferDirty: vi.fn(),
  mockMarkBrushBufferClean: vi.fn(),
  mockRecalculateBrushPaintedBounds: vi.fn(),
  mockAddLocalAsset: vi.fn(),
  mockDeleteAsset: vi.fn(),
}));

vi.mock("../brushBufferRegistry", () => ({
  disposeBrushBuffer: mockDisposeBrushBuffer,
  extractBrushPng: mockExtractBrushPng,
  getBrushBuffer: mockGetBrushBuffer,
  isBrushBufferDirty: mockIsBrushBufferDirty,
  markBrushBufferClean: mockMarkBrushBufferClean,
  recalculateBrushPaintedBounds: mockRecalculateBrushPaintedBounds,
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
    mockRecalculateBrushPaintedBounds.mockResolvedValue(null);
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
    mockRecalculateBrushPaintedBounds.mockResolvedValue({
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    });

    await flushBrushMaskCommit("clip_deleted::mask::mask_brush");

    expect(mockAddLocalAsset).not.toHaveBeenCalled();
    expect(mockDeleteAsset).not.toHaveBeenCalled();
    expect(mockDisposeBrushBuffer).toHaveBeenCalledWith(
      "clip_deleted::mask::mask_brush",
    );
    expect(mockMarkBrushBufferClean).not.toHaveBeenCalled();
  });

  it("uses recalculated painted bounds when flushing a dirty brush mask", async () => {
    const initialBounds = { x: 0, y: 0, width: 80, height: 80 };
    const recalculatedBounds = { x: 20, y: 24, width: 12, height: 16 };
    const brushMask = createBrushMaskClip("brush-asset-1", initialBounds);

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [createParentClip(brushMask.id), brushMask],
    });

    mockIsBrushBufferDirty.mockReturnValue(true);
    mockRecalculateBrushPaintedBounds.mockResolvedValue(recalculatedBounds);
    mockExtractBrushPng.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    mockAddLocalAsset.mockResolvedValue({ id: "brush-asset-2" });

    await flushBrushMaskCommit(brushMask.id);

    expect(mockExtractBrushPng).toHaveBeenCalledWith(
      brushMask.id,
      recalculatedBounds,
    );
    const updatedMask = useTimelineStore
      .getState()
      .clips.find((clip): clip is MaskTimelineClip => clip.id === brushMask.id);
    expect(updatedMask?.brushPaintedBounds).toEqual(recalculatedBounds);
    expect(updatedMask?.brushMaskAssetId).toBe("brush-asset-2");
    expect(mockMarkBrushBufferClean).toHaveBeenCalledWith(
      brushMask.id,
      "brush-asset-2",
    );
  });

  it("keeps a non-empty buffer dirty when it cannot be materialized", async () => {
    const initialBounds = { x: 0, y: 0, width: 80, height: 80 };
    const recalculatedBounds = { x: 20, y: 24, width: 12, height: 16 };
    const brushMask = createBrushMaskClip("brush-asset-1", initialBounds);

    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [createTrack("track_1")],
      clips: [createParentClip(brushMask.id), brushMask],
    });

    mockIsBrushBufferDirty.mockReturnValue(true);
    mockRecalculateBrushPaintedBounds.mockResolvedValue(recalculatedBounds);
    mockExtractBrushPng.mockResolvedValue(null);

    await flushBrushMaskCommit(brushMask.id);

    expect(mockExtractBrushPng).toHaveBeenCalledWith(
      brushMask.id,
      recalculatedBounds,
    );
    expect(mockMarkBrushBufferClean).not.toHaveBeenCalled();
  });
});
