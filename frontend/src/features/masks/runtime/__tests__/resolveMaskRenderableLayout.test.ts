import { describe, expect, it } from "vitest";
import type { ClipTransform, MaskTimelineClip } from "../../../../types/TimelineTypes";
import type { ClipMask } from "../../../../types/TimelineTypes";
import { getMaskLayoutState, createMaskLayoutTransforms } from "../../model/maskFactory";
import {
  createMaskRenderableShapeSource,
  getMaskRenderableBaseSize,
  resolvePaintedBoundsLayout,
} from "../../model/maskRenderableLayout";
import { resolveMaskRenderableLayout } from "../resolveMaskRenderableLayout";

function createMaskClip(
  localId: string,
  options: {
    maskType?: MaskTimelineClip["maskType"];
    baseWidth?: number;
    baseHeight?: number;
    brushPaintedBounds?: MaskTimelineClip["brushPaintedBounds"];
    transformations?: ClipTransform[];
  } = {},
): MaskTimelineClip {
  const id = `clip_1::mask::${localId}`;
  return {
    id,
    trackId: "track_1",
    type: "mask",
    name: localId,
    sourceDuration: 500,
    start: 0,
    timelineDuration: 500,
    offset: 0,
    transformedDuration: 500,
    transformedOffset: 0,
    croppedSourceDuration: 500,
    transformations:
      options.transformations ??
      createMaskLayoutTransforms(id, {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
      }),
    parentClipId: "clip_1",
    maskType: options.maskType ?? "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: options.baseWidth ?? 100,
      baseHeight: options.baseHeight ?? 80,
    },
    brushPaintedBounds: options.brushPaintedBounds,
  };
}

describe("resolveMaskRenderableLayout", () => {
  it("returns vector base-shape layouts from mask parameters", () => {
    const maskClip = createMaskClip("mask_vector", {
      maskType: "triangle",
      baseWidth: 140,
      baseHeight: 90,
    });

    const resolved = resolveMaskRenderableLayout(maskClip, {
      parentClipContentSize: { width: 1920, height: 1080 },
    });

    expect(resolved.localMaskId).toBe("mask_vector");
    expect(resolved.hitArea).toBe("base-shape");
    expect(resolved.contentSize).toEqual({ width: 140, height: 90 });
  });

  it("uses decoded asset texture size first and falls back to the parent clip size", () => {
    const generationMask = createMaskClip("mask_generation", {
      maskType: "generation",
      baseWidth: 1,
      baseHeight: 1,
    });

    const decoded = resolveMaskRenderableLayout(generationMask, {
      parentClipContentSize: { width: 1920, height: 1080 },
      assetTextureSize: { width: 640, height: 360 },
    });
    const fallback = resolveMaskRenderableLayout(generationMask, {
      parentClipContentSize: { width: 1920, height: 1080 },
    });

    expect(decoded.hitArea).toBe("asset-rectangle");
    expect(decoded.contentSize).toEqual({ width: 640, height: 360 });
    expect(fallback.contentSize).toEqual({ width: 1920, height: 1080 });
  });

  it("builds brush painted-bounds shapes with the adjusted presentation layout", () => {
    const layout = {
      x: 42,
      y: -18,
      scaleX: 1.5,
      scaleY: 0.75,
      rotation: 0.35,
    };
    const brushMask = createMaskClip("mask_brush", {
      maskType: "brush",
      baseWidth: 120,
      baseHeight: 80,
      brushPaintedBounds: { x: 18, y: 12, width: 44, height: 28 },
    });

    const resolved = resolveMaskRenderableLayout(brushMask, {
      layout,
      parentClipContentSize: { width: 1920, height: 1080 },
    });
    const shape = createMaskRenderableShapeSource(brushMask, resolved);

    expect(resolved.hitArea).toBe("painted-bounds");
    expect(resolved.contentSize).toEqual({ width: 120, height: 80 });
    expect(getMaskRenderableBaseSize(shape)).toEqual({
      width: 44,
      height: 28,
    });
    expect(getMaskLayoutState(shape as unknown as ClipMask)).toEqual(
      resolvePaintedBoundsLayout(layout, resolved.contentSize, {
        x: 18,
        y: 12,
        width: 44,
        height: 28,
      }),
    );
  });
});
