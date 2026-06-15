import type { Asset } from "../../../types/Asset";
import type {
  ClipMaskPoint,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import {
  getRenderedSourceFrameReferenceFromTicks,
  type RenderedSourceFrameReference,
} from "../../renderer/utils/mediaTime";

export type { RenderedSourceFrameReference };

export function estimateAssetFrameCount(
  asset: Asset | undefined,
  fps: number,
): number | undefined {
  if (
    !asset ||
    typeof asset.duration !== "number" ||
    !Number.isFinite(asset.duration) ||
    asset.duration <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  ) {
    return undefined;
  }
  return Math.max(1, Math.round(asset.duration * fps));
}

export function resolveRenderedSourceFrameForAsset(
  clip: TimelineClip | null,
  asset: Asset | undefined,
  sourceTimeTicks: number,
  fallbackFps: number,
  frameCount?: number,
): RenderedSourceFrameReference | null {
  if (!clip) return null;
  if (asset?.type === "image") {
    return { frameIndex: 0, timeSeconds: 0, timeTicks: 0 };
  }
  const sourceFps =
    typeof asset?.fps === "number" && Number.isFinite(asset.fps) && asset.fps > 0
      ? asset.fps
      : fallbackFps;
  return getRenderedSourceFrameReferenceFromTicks(
    sourceTimeTicks,
    sourceFps,
    frameCount ?? estimateAssetFrameCount(asset, sourceFps),
  );
}

export function resolveRenderedSourceFrameForClipAssets(
  clip: TimelineClip,
  sourceTimeTicks: number,
  assets: readonly Asset[],
  fallbackFps: number,
): RenderedSourceFrameReference {
  if (!isAssetBackedClip(clip)) {
    return getRenderedSourceFrameReferenceFromTicks(sourceTimeTicks, fallbackFps);
  }

  return (
    resolveRenderedSourceFrameForAsset(
      clip,
      assets.find((asset) => asset.id === clip.assetId),
      sourceTimeTicks,
      fallbackFps,
    ) ?? getRenderedSourceFrameReferenceFromTicks(sourceTimeTicks, fallbackFps)
  );
}

export function isPointOnRenderedSourceFrame(
  point: ClipMaskPoint,
  clip: TimelineClip | null,
  asset: Asset | undefined,
  frame: RenderedSourceFrameReference | null,
  fallbackFps: number,
  frameCount?: number,
): boolean {
  if (!frame) return false;
  return (
    resolveRenderedSourceFrameForAsset(
      clip,
      asset,
      point.timeTicks,
      fallbackFps,
      frameCount,
    )?.frameIndex === frame.frameIndex
  );
}

/**
 * Load-bearing for SAM2 requests: renderer display uses nearest-frame snapping,
 * while the backend groups incoming ticks with floor + tiny boundary epsilon.
 * Canonicalizing here makes legacy raw point ticks and new editor points agree
 * with the source frame users actually see before any request reaches SAM2.
 */
export function normalizeSam2PointsToRenderedSourceFrames(
  points: ClipMaskPoint[],
  fps: number,
  frameCount: number,
): ClipMaskPoint[] {
  return points.map((point) => ({
    ...point,
    timeTicks: getRenderedSourceFrameReferenceFromTicks(
      point.timeTicks,
      fps,
      frameCount,
    ).timeTicks,
  }));
}

/**
 * Stable FNV-1a hash of a SAM2 point set. Used to decide whether a transient
 * single-frame preview still reflects the current points (any edit invalidates
 * it) and shared between the panel that generates previews and the overlay that
 * gates their display.
 */
export function hashSam2Points(points: readonly ClipMaskPoint[]): string {
  let hash = 2166136261;
  for (const point of points) {
    const token = `${point.x.toFixed(6)}|${point.y.toFixed(6)}|${point.label}|${point.timeTicks.toFixed(6)};`;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function areSam2PointsEqual(
  left: readonly ClipMaskPoint[],
  right: readonly ClipMaskPoint[],
): boolean {
  return (
    left.length === right.length &&
    left.every((point, index) => {
      const other = right[index];
      return (
        other &&
        point.x === other.x &&
        point.y === other.y &&
        point.label === other.label &&
        point.timeTicks === other.timeTicks
      );
    })
  );
}
