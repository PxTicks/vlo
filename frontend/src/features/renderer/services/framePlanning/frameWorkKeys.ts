import type {
  ClipTransform,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";
import type {
  FrameDimensions,
  FrameWorkKey,
  ResolvedCompositeSource,
  ResolvedClipFrameJob,
} from "./framePlanningTypes";

function keyNumber(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(9)).toString() : "0";
}

function dimensionsKey(dimensions: FrameDimensions): readonly [number, number] {
  return [dimensions.width, dimensions.height];
}

function serializeParts(
  kind: string,
  parts: readonly (string | number | boolean | null | readonly unknown[])[],
): FrameWorkKey {
  return JSON.stringify([kind, ...parts]);
}

export function createSourceFrameWorkKey(
  job: ResolvedClipFrameJob,
): FrameWorkKey {
  return job.sourceFrame.decodeKey
    ? serializeParts("source", [job.sourceFrame.decodeKey])
    : serializeParts("generated-source", [
        job.activeClip.id,
        job.sourceFrame.key,
      ]);
}

export function createCompositeSceneWorkKey(
  epoch: number,
  source: ResolvedCompositeSource,
): FrameWorkKey {
  return serializeParts("composite-scene", [
    source.isStateless ? "stateless" : epoch,
    source.isStateless ? null : source.placementId,
    source.compositeId,
    source.revision,
    source.bakeKey,
    keyNumber(source.localPresentationTick),
    dimensionsKey(source.logicalDimensions),
    source.fps,
  ]);
}

function maskIdentity(mask: MaskTimelineClip): readonly unknown[] {
  return [
    mask.id,
    mask.maskType,
    mask.maskMode,
    mask.maskInverted,
    mask.sam2MaskAssetId ?? null,
    mask.generationMaskAssetId ?? null,
    mask.brushMaskAssetId ?? null,
    mask.activeRange
      ? [mask.activeRange.startSourceTicks, mask.activeRange.endSourceTicks]
      : null,
    (mask.transformations ?? []).map(transformIdentity),
  ];
}

function transformIdentity(transform: ClipTransform): readonly unknown[] {
  return [
    transform.id,
    transform.type,
    transform.isEnabled,
    transform.effectMask?.enabled ?? false,
    transform.effectMask?.expression ?? null,
    transform.parameters,
  ];
}

/**
 * Coverage/effect reuse remains frame-local until every external readiness
 * revision has a first-class identity. The explicit epoch/job fields are not a
 * speculative cache key: they deliberately prevent cross-frame reuse while
 * still making every pixel-affecting value visible to diagnostics and tests.
 */
export function createMaskSyncWorkKey(
  epoch: number,
  job: ResolvedClipFrameJob,
): FrameWorkKey {
  return serializeParts("mask-sync", [
    epoch,
    job.id,
    job.sourceFrame.key,
    keyNumber(job.rawClipTick),
    dimensionsKey(job.logicalDimensions),
    dimensionsKey(job.contentSize),
    job.maskClips.map(maskIdentity),
    job.activeClip.type === "mask" ? [] : (job.activeClip.components ?? []),
  ]);
}

export function createMaskCoverageWorkKey(
  epoch: number,
  job: ResolvedClipFrameJob,
): FrameWorkKey {
  return serializeParts("mask-coverage", [
    epoch,
    job.id,
    createMaskSyncWorkKey(epoch, job),
  ]);
}

export function createEffectChainWorkKey(
  epoch: number,
  job: ResolvedClipFrameJob,
): FrameWorkKey {
  return serializeParts("effect-chain", [
    epoch,
    job.id,
    createSourceFrameWorkKey(job),
    createMaskCoverageWorkKey(epoch, job),
    dimensionsKey(job.logicalDimensions),
    dimensionsKey(job.contentSize),
    keyNumber(job.rawClipTick),
    [
      ...(job.activeClip.transformations ?? []),
      ...(job.transitionTransforms ?? []),
    ].map(transformIdentity),
  ]);
}

export function createClipOutputWorkKey(
  epoch: number,
  job: ResolvedClipFrameJob,
): FrameWorkKey {
  return serializeParts("clip-output", [
    epoch,
    job.id,
    createEffectChainWorkKey(epoch, job),
  ]);
}
