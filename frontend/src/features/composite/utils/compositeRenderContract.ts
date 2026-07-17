import { getTicksPerFrame } from "../../../core/time/ticksPerFrame";
import type { Asset } from "../../../types/Asset";
import type { CompositeContent } from "../../../types/TimelineTypes";
import { isAssetBackedClip } from "../../../types/TimelineTypes";
import { hashCompositeContent } from "../../timelineSelection";

/**
 * Increment whenever a renderer change can alter composite pixels without an
 * authored-content or dependency change. Existing bakes with an older version
 * are caches for a different render contract and must not be selected.
 */
export const COMPOSITE_RENDER_CONTRACT_VERSION = 2;

/**
 * Composite scenes are isolated transparent, project-sized layers. User-facing
 * opaque video exports are a delivery format, not the internal cache contract.
 */
export const COMPOSITE_RENDER_ALPHA_MODE = "transparent" as const;

/** Composite authored time is a half-open local interval: 0 <= t < duration. */
export const COMPOSITE_FRAME_INTERVAL = "half-open" as const;

/** Playback caches always render every frame; workflow stride is not inherited. */
export const COMPOSITE_RENDER_FRAME_STEP = 1;

export interface CompositeRenderDimensions {
  width: number;
  height: number;
}

export interface CompositeBakeKey {
  contentHash: string;
  resolvedFps: number;
  logicalWidth: number;
  logicalHeight: number;
  renderContractVersion: number;
  alphaMode: typeof COMPOSITE_RENDER_ALPHA_MODE;
  dependencyRevision: string;
}

export interface CreateCompositeBakeKeyOptions {
  content: CompositeContent;
  projectFps: number;
  logicalDimensions: CompositeRenderDimensions;
  assets: readonly Asset[];
}

export interface CompositeFrameSchedule {
  durationTicks: number;
  fps: number;
  ticksPerFrame: number;
  /**
   * Encoders need one transparent frame for empty content, while the authored
   * interval itself remains empty and resolves no content samples.
   */
  frameCount: number;
  hasAuthoredFrames: boolean;
  interval: typeof COMPOSITE_FRAME_INTERVAL;
  frameStep: typeof COMPOSITE_RENDER_FRAME_STEP;
}

export interface CompositeFrameSample {
  frameIndex: number;
  presentationTick: number;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

export function resolveCompositeRenderFps(
  content: CompositeContent,
  projectFps: number,
): number {
  const fallback = normalizePositiveInteger(projectFps, 1);
  return normalizePositiveInteger(content.fps ?? fallback, fallback);
}

function addAssetId(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    ids.add(value);
  }
}

/**
 * Collects core-known assets whose bytes affect composite pixels or audio.
 * Extension-owned external dependencies are covered by bumping the render
 * contract version until extensions expose a typed dependency contract.
 */
export function collectCompositeDependencyAssetIds(
  content: CompositeContent,
): string[] {
  const ids = new Set<string>();

  for (const clip of content.clips) {
    if (isAssetBackedClip(clip)) {
      addAssetId(ids, clip.assetId);
    }

    if (clip.type === "mask") {
      addAssetId(ids, clip.sam2MaskAssetId);
      addAssetId(ids, clip.generationMaskAssetId);
      addAssetId(ids, clip.brushMaskAssetId);
    }

    for (const transform of clip.transformations ?? []) {
      // The colour-grade LUT is the only current transform-owned asset. Keep
      // this explicit so arbitrary string parameters never become dependencies.
      addAssetId(ids, transform.parameters?.lutAssetId);
    }
  }

  return [...ids].sort();
}

/**
 * Asset ids identify references; asset hashes identify the bytes rendered by
 * those references. Missing assets are included explicitly so hydration or
 * restoration changes the revision and invalidates a degraded bake.
 */
export function createCompositeDependencyRevision(
  content: CompositeContent,
  assets: readonly Asset[],
): string {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const dependencies = collectCompositeDependencyAssetIds(content).map((id) => {
    const asset = assetsById.get(id);
    return [id, asset?.hash || "missing"] as const;
  });
  return hashString(JSON.stringify(dependencies));
}

export function createCompositeBakeKey(
  options: CreateCompositeBakeKeyOptions,
): CompositeBakeKey {
  const width = normalizePositiveInteger(options.logicalDimensions.width, 1);
  const height = normalizePositiveInteger(options.logicalDimensions.height, 1);

  return {
    contentHash: hashCompositeContent(options.content),
    resolvedFps: resolveCompositeRenderFps(
      options.content,
      options.projectFps,
    ),
    logicalWidth: width,
    logicalHeight: height,
    renderContractVersion: COMPOSITE_RENDER_CONTRACT_VERSION,
    alphaMode: COMPOSITE_RENDER_ALPHA_MODE,
    dependencyRevision: createCompositeDependencyRevision(
      options.content,
      options.assets,
    ),
  };
}

/** Stable persisted/cache identity; field order is deliberately explicit. */
export function serializeCompositeBakeKey(key: CompositeBakeKey): string {
  return [
    `v${key.renderContractVersion}`,
    key.contentHash,
    `${key.resolvedFps}fps`,
    `${key.logicalWidth}x${key.logicalHeight}`,
    key.alphaMode,
    key.dependencyRevision,
  ].join(":");
}

export function createCompositeFrameSchedule(
  durationTicks: number,
  fps: number,
): CompositeFrameSchedule {
  const safeDuration = Math.max(
    0,
    Number.isFinite(durationTicks) ? Math.round(durationTicks) : 0,
  );
  const safeFps = normalizePositiveInteger(fps, 1);
  const ticksPerFrame = getTicksPerFrame(safeFps);
  const authoredFrameCount =
    safeDuration > 0 ? Math.ceil(safeDuration / ticksPerFrame) : 0;

  return {
    durationTicks: safeDuration,
    fps: safeFps,
    ticksPerFrame,
    frameCount: Math.max(1, authoredFrameCount),
    hasAuthoredFrames: authoredFrameCount > 0,
    interval: COMPOSITE_FRAME_INTERVAL,
    frameStep: COMPOSITE_RENDER_FRAME_STEP,
  };
}

/**
 * Resolves the same nearest cache frame that an asset-backed video decoder
 * would select. Ticks outside the authored half-open interval resolve blank;
 * they never freeze or clamp to stale content beyond the composite end.
 */
export function resolveCompositeFrameSample(
  tick: number,
  schedule: CompositeFrameSchedule,
): CompositeFrameSample | null {
  if (
    !Number.isFinite(tick) ||
    tick < 0 ||
    tick >= schedule.durationTicks ||
    !schedule.hasAuthoredFrames
  ) {
    return null;
  }

  const frameIndex = Math.min(
    schedule.frameCount - 1,
    Math.max(0, Math.round(tick / schedule.ticksPerFrame)),
  );
  return {
    frameIndex,
    presentationTick: frameIndex * schedule.ticksPerFrame,
  };
}
