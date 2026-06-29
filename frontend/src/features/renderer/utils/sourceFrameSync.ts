import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  getRenderedSourceFrameReferenceFromSeconds,
  tickToMediaSeconds,
} from "./mediaTime";
import { resolveClipRenderTimeFromEffectiveTick } from "./clipRenderTime";

export interface SourceFrameSyncRef {
  clipId: string;
  assetId: string | null;
  effectiveTrackTick: number;
  rawClipTick: number;
  sourceTimeTicks: number;
  sourceTimeSeconds: number;
  snappedTimeSeconds: number;
  frameIndex: number;
  fps: number;
  /**
   * Clip-scoped identity. Includes `clipId`, so two duplicate clips at the same
   * source frame produce *different* keys — this is what keeps stale async
   * completions on the right clip (see `isSourceFrameIntentCurrent`).
   */
  key: string;
  /**
   * Decode identity: the same frame parts as `key` *minus* `clipId`. Two
   * duplicate clips at the same asset/frame/fps share one `decodeKey`, so a
   * decode scheduler can coalesce their decode requests. `null` for frames that
   * are not a shared asset decode (text, brush) — those must never be deduped.
   */
  decodeKey: string | null;
  generation: number;
}

export interface SourceFrameSyncIntent {
  generation: number;
  key: string;
}

interface CreateSourceFrameSyncRefOptions {
  clip: TimelineClip;
  assetId?: string | null;
  effectiveTrackTick: number;
  fps: number;
  generation: number;
  frameCount?: number;
}

interface CreateSourceFrameSyncRefFromSourceTicksOptions {
  clip: TimelineClip;
  assetId?: string | null;
  effectiveTrackTick: number;
  rawClipTick: number;
  sourceTimeTicks: number;
  fps: number;
  generation: number;
  frameCount?: number;
}

function safeFrameRate(fps: number): number {
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : 1;
}

function keyNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(9)).toString();
}

/**
 * The asset-frame identity parts shared by the clip key and the decode key:
 * everything that identifies *which decoded source frame* this is, independent
 * of which clip instance asked for it. Keeping both keys built from one parts
 * function guarantees they stay in lockstep (same snapping, same fps coercion).
 */
function frameIdentityKeyParts(options: {
  assetId?: string | null;
  frameIndex: number;
  fps: number;
  snappedTimeSeconds: number;
}): string[] {
  return [
    options.assetId ?? "",
    String(Math.max(0, Math.trunc(options.frameIndex))),
    keyNumber(safeFrameRate(options.fps)),
    keyNumber(Math.max(0, options.snappedTimeSeconds)),
  ];
}

export function createSourceFrameSyncKey(options: {
  clipId: string;
  assetId?: string | null;
  frameIndex: number;
  fps: number;
  snappedTimeSeconds: number;
}): string {
  return [options.clipId, ...frameIdentityKeyParts(options)].join(":");
}

/**
 * Decode-dedup identity: the frame parts of {@link createSourceFrameSyncKey}
 * without `clipId`. Two duplicate clips at the same asset/frame/fps/time map to
 * the same `decodeKey` and can share a single decode.
 *
 * Returns `null` when there is no backing asset (text- or brush-derived
 * frames): those textures are generated per clip, not decoded from a shared
 * source, so they must never participate in decode dedup.
 */
export function createDecodeKey(options: {
  assetId?: string | null;
  frameIndex: number;
  fps: number;
  snappedTimeSeconds: number;
}): string | null {
  const assetId = options.assetId ?? null;
  if (!assetId) {
    return null;
  }
  return frameIdentityKeyParts({ ...options, assetId }).join(":");
}

export function createSourceFrameSyncRefFromSourceTicks(
  options: CreateSourceFrameSyncRefFromSourceTicksOptions,
): SourceFrameSyncRef {
  const fps = safeFrameRate(options.fps);
  const sourceTimeSeconds = Math.max(
    0,
    tickToMediaSeconds(options.sourceTimeTicks),
  );
  const renderedSourceFrame = getRenderedSourceFrameReferenceFromSeconds(
    sourceTimeSeconds,
    fps,
    options.frameCount,
  );
  const canonicalSnappedTimeSeconds = renderedSourceFrame.timeSeconds;
  return {
    clipId: options.clip.id,
    assetId: options.assetId ?? null,
    effectiveTrackTick: options.effectiveTrackTick,
    rawClipTick: options.rawClipTick,
    sourceTimeTicks: options.sourceTimeTicks,
    sourceTimeSeconds,
    snappedTimeSeconds: canonicalSnappedTimeSeconds,
    frameIndex: renderedSourceFrame.frameIndex,
    fps,
    key: createSourceFrameSyncKey({
      clipId: options.clip.id,
      assetId: options.assetId ?? null,
      frameIndex: renderedSourceFrame.frameIndex,
      fps,
      snappedTimeSeconds: canonicalSnappedTimeSeconds,
    }),
    decodeKey: createDecodeKey({
      assetId: options.assetId ?? null,
      frameIndex: renderedSourceFrame.frameIndex,
      fps,
      snappedTimeSeconds: canonicalSnappedTimeSeconds,
    }),
    generation: options.generation,
  };
}

export function createSourceFrameSyncRef(
  options: CreateSourceFrameSyncRefOptions,
): SourceFrameSyncRef {
  const renderTime = resolveClipRenderTimeFromEffectiveTick({
    clip: options.clip,
    effectiveTrackTick: options.effectiveTrackTick,
  });
  return createSourceFrameSyncRefFromSourceTicks({
    clip: options.clip,
    assetId: options.assetId ?? null,
    effectiveTrackTick: options.effectiveTrackTick,
    rawClipTick: renderTime.clipVisualTimeTicks,
    sourceTimeTicks: renderTime.sourceTimeTicks,
    fps: options.fps,
    generation: options.generation,
    frameCount: options.frameCount,
  });
}

export function isSourceFrameIntentCurrent(
  current: SourceFrameSyncIntent | null,
  expected: SourceFrameSyncIntent,
): boolean {
  return (
    current !== null &&
    current.generation === expected.generation &&
    current.key === expected.key
  );
}
