import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { MaskTimelineClip } from "../../../../types/TimelineTypes";
import type { BrushBuffer } from "../brushBufferRegistry";

const {
  mockGetBrushBuffer,
  mockGetBrushBufferForRenderer,
} = vi.hoisted(() => ({
  mockGetBrushBuffer: vi.fn<() => BrushBuffer | null>(() => null),
  mockGetBrushBufferForRenderer:
    vi.fn<(maskId: string, renderer: Renderer) => BrushBuffer | null>(
      () => null,
    ),
}));

vi.mock("../brushBufferRegistry", () => ({
  getBrushBuffer: mockGetBrushBuffer,
  getBrushBufferForRenderer: mockGetBrushBufferForRenderer,
}));

import { AssetMaskSourceFactory } from "../AssetMaskSourceFactory";

function createMask(
  maskType: MaskTimelineClip["maskType"],
  overrides: Partial<MaskTimelineClip> = {},
): MaskTimelineClip {
  return {
    id: `clip::mask::${maskType}`,
    trackId: "track",
    type: "mask",
    name: "Mask",
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId: "clip",
    maskType,
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 64, baseHeight: 64 },
    ...overrides,
  };
}

function createImageAsset(id: string): Asset {
  return {
    id,
    type: "image",
    name: `${id}.png`,
    src: `${id}.png`,
    hash: `${id}-hash`,
    createdAt: 0,
  };
}

describe("AssetMaskSourceFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrushBuffer.mockReturnValue(null);
    mockGetBrushBufferForRenderer.mockReturnValue(null);
  });

  it("routes SAM2 PNG masks to immutable image sources", () => {
    const renderer = {} as Renderer;
    const factory = new AssetMaskSourceFactory(renderer);
    const mask = createMask("sam2", {
      sam2MaskAssetId: "sam2-png",
    });

    expect(
      factory.resolveMaskEntry(
        mask,
        new Map([["sam2-png", createImageAsset("sam2-png")]]),
      ),
    ).toEqual({
      maskId: mask.id,
      assetId: "sam2-png",
      kind: "image",
    });
  });

  it("keeps live paint on its owner and gives other renderers the PNG", () => {
    const liveRenderer = {} as Renderer;
    const exportRenderer = {} as Renderer;
    const buffer = {
      renderer: liveRenderer,
      renderTexture: {},
      canvasSize: { width: 64, height: 64 },
      paintedBounds: { x: 2, y: 3, width: 10, height: 12 },
      dirty: true,
      revision: 4,
      sourceAssetId: null,
    } as BrushBuffer;
    mockGetBrushBuffer.mockReturnValue(buffer);
    mockGetBrushBufferForRenderer.mockImplementation(
      (_maskId, renderer) => renderer === liveRenderer ? buffer : null,
    );
    const mask = createMask("brush", {
      brushMaskAssetId: "committed-brush-png",
    });

    expect(
      new AssetMaskSourceFactory(liveRenderer).resolveMaskEntry(mask),
    ).toMatchObject({ kind: "brush" });
    expect(
      new AssetMaskSourceFactory(exportRenderer).resolveMaskEntry(mask),
    ).toEqual({
      maskId: mask.id,
      assetId: "committed-brush-png",
      kind: "image",
    });
  });
});
