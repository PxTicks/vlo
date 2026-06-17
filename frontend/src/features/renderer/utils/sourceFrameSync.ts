import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  calculatePlayerFrameTime,
  getRenderedSourceFrameReferenceFromSeconds,
  mediaSecondsToTickExact,
  tickToMediaSeconds,
} from "./mediaTime";

export interface SourceFrameSyncRef {
  clipId: string;
  assetId: string | null;
  effectiveTrackTick: number;
  rawClipTick: number;
  sourceTimeSeconds: number;
  snappedTimeSeconds: number;
  frameIndex: number;
  fps: number;
  key: string;
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

export function createSourceFrameSyncKey(options: {
  clipId: string;
  assetId?: string | null;
  frameIndex: number;
  fps: number;
  snappedTimeSeconds: number;
}): string {
  return [
    options.clipId,
    options.assetId ?? "",
    Math.max(0, Math.trunc(options.frameIndex)),
    keyNumber(safeFrameRate(options.fps)),
    keyNumber(Math.max(0, options.snappedTimeSeconds)),
  ].join(":");
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
    generation: options.generation,
  };
}

export function createSourceFrameSyncRef(
  options: CreateSourceFrameSyncRefOptions,
): SourceFrameSyncRef {
  const sourceTimeSeconds = calculatePlayerFrameTime(
    options.clip,
    options.effectiveTrackTick,
  );
  return createSourceFrameSyncRefFromSourceTicks({
    clip: options.clip,
    assetId: options.assetId ?? null,
    effectiveTrackTick: options.effectiveTrackTick,
    rawClipTick: options.effectiveTrackTick - options.clip.start,
    sourceTimeTicks: mediaSecondsToTickExact(sourceTimeSeconds),
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
