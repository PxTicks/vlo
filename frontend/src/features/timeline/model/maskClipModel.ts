import {
  DEFAULT_MASK_COMPOSITION_ALGEBRA,
  type Component,
  type MaskCompositionAlgebra,
  type MaskCompositionComponent,
  type MaskCompositionComponentParameters,
  type MaskRefComponent,
} from "../../../types/Components";
import type {
  ClipMask,
  ClipMaskMode,
  ClipMaskParameters,
  ClipMaskPoint,
  ClipMaskType,
  ClipTransform,
  MaskActiveRange,
  MaskTimelineClip,
  StandardTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { isNonMaskTimelineClip } from "../../../types/TimelineTypes";
import {
  getMaskLocalId,
  pruneMaskBooleanExpression,
} from "../../masks/model/maskBooleanExpression";

const MASK_CONTEXT_SEPARATOR = "::mask::";
const INHERITED_TRANSFORM_TYPES = new Set(["speed"]);
const MASK_EDGE_TRANSFORM_TYPES = new Set(["mask_grow", "feather"]);

interface TimelineModelStateLike {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

function areClipTransformArraysEqual(
  left: readonly ClipTransform[],
  right: readonly ClipTransform[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Normalize a `mask_composition` component's compositeTransformations so only
 * mask-edge transforms survive. Drops the component entirely if it ends up
 * empty (no expression, no explicit algebra, and no edge transforms).
 * Returns the same reference when no change is required, so callers can
 * cheaply detect no-ops.
 */
export function normalizeComponentsMaskComposite(
  components: Component[] | undefined,
): Component[] | undefined {
  if (!components || components.length === 0) return components;

  let changed = false;
  const next: Component[] = [];
  for (const component of components) {
    if (component.type !== "mask_composition") {
      next.push(component);
      continue;
    }
    const normalizedParams = normalizeMaskCompositionParameters(
      component.parameters,
    );
    const normalizedTransforms = normalizedParams.compositeTransformations;
    const expressionIsSet = component.parameters.expression !== undefined;
    const algebraIsSet = component.parameters.algebra !== undefined;
    if (
      !expressionIsSet &&
      normalizedTransforms.length === 0 &&
      !algebraIsSet
    ) {
      changed = true;
      continue;
    }
    const originalTransforms = component.parameters.compositeTransformations;
    const transformsChanged = !areClipTransformArraysEqual(
      normalizedTransforms,
      originalTransforms,
    );
    const algebraChanged =
      component.parameters.algebra !== normalizedParams.algebra;
    if (!transformsChanged && !algebraChanged) {
      next.push(component);
      continue;
    }
    changed = true;
    next.push({
      ...component,
      parameters: normalizedParams,
    });
  }
  if (!changed) return components;
  return next.length > 0 ? next : undefined;
}

export const cloneTimelineClip = (
  clip: TimelineClip,
  id: string = clip.id,
): TimelineClip => {
  const cloned = structuredClone(clip);
  cloned.id = id;
  return cloned;
};

/** Read all typed components from a clip (only standard clips carry them). */
function getClipComponents(clip: TimelineClip): Component[] {
  return isNonMaskTimelineClip(clip) ? (clip.components ?? []) : [];
}

/** Mutably set the components array on a standard clip. */
function setClipComponents(
  clip: TimelineClip,
  components: Component[],
): void {
  if (isNonMaskTimelineClip(clip)) {
    clip.components = components.length > 0 ? components : undefined;
  }
}

function getMaskRefComponents(clip: TimelineClip): MaskRefComponent[] {
  return getClipComponents(clip).filter(
    (component): component is MaskRefComponent => component.type === "mask_ref",
  );
}

export function getChildMaskClipIds(clip: TimelineClip): string[] {
  return getMaskRefComponents(clip).map(
    (component) => component.parameters.maskClipId,
  );
}

function getMaskCompositionComponent(
  clip: TimelineClip,
): MaskCompositionComponent | null {
  const found = getClipComponents(clip).find(
    (component): component is MaskCompositionComponent =>
      component.type === "mask_composition",
  );
  return found ?? null;
}

/**
 * Upsert the parent's single `mask_composition` component in place on a draft.
 * Pass a null return from the updater to drop the component entirely (used to
 * clear empty composite transforms without leaving a stub component behind).
 */
export function updateMaskCompositionOnDraft(
  clip: StandardTimelineClip,
  updater: (
    current: MaskCompositionComponentParameters,
  ) => MaskCompositionComponentParameters | null,
): void {
  const existing = getMaskCompositionComponent(clip);
  const currentParams: MaskCompositionComponentParameters =
    existing?.parameters
      ? normalizeMaskCompositionParameters(existing.parameters)
      : { compositeTransformations: [] };
  const nextParams = updater(currentParams);
  const withoutComposition = (clip.components ?? []).filter(
    (component) => component.type !== "mask_composition",
  );

  if (!nextParams) {
    setClipComponents(clip, withoutComposition);
    return;
  }

  const nextComponent: MaskCompositionComponent = {
    id: existing?.id ?? crypto.randomUUID(),
    type: "mask_composition",
    parameters: normalizeMaskCompositionParameters(nextParams),
  };
  setClipComponents(clip, [...withoutComposition, nextComponent]);
}

/**
 * Does this composition-component params still carry meaningful state?
 * A component with no expression (legacy auto-union) and no edge transforms
 * should be dropped entirely rather than left as a stub.
 */
export function isMaskCompositionComponentMeaningful(
  params: MaskCompositionComponentParameters,
): boolean {
  return (
    params.expression !== undefined ||
    params.algebra !== undefined ||
    params.compositeTransformations.length > 0
  );
}

export function getOrderedChildMaskClips(
  clips: readonly TimelineClip[],
  parent: TimelineClip,
): MaskTimelineClip[] {
  const clipById = new Map(clips.map((clip) => [clip.id, clip] as const));

  return getChildMaskClipIds(parent)
    .map((maskClipId) => clipById.get(maskClipId))
    .filter((clip): clip is MaskTimelineClip => !!clip && clip.type === "mask");
}

function getSam2MaskAssetId(clip: TimelineClip): string | null {
  return clip.type === "mask" ? clip.sam2MaskAssetId ?? null : null;
}

function getBrushMaskAssetId(clip: TimelineClip): string | null {
  return clip.type === "mask" ? clip.brushMaskAssetId ?? null : null;
}

function getMaskBackingAssetIds(clip: TimelineClip): string[] {
  const ids: string[] = [];
  const sam2 = getSam2MaskAssetId(clip);
  if (sam2) ids.push(sam2);
  const brush = getBrushMaskAssetId(clip);
  if (brush) ids.push(brush);
  return ids;
}

export function countSam2MaskAssetConsumers(
  clips: readonly TimelineClip[],
  assetId: string | null | undefined,
): number {
  if (!assetId) {
    return 0;
  }

  return clips.reduce((count, clip) => {
    return count + (getSam2MaskAssetId(clip) === assetId ? 1 : 0);
  }, 0);
}

export function countBrushMaskAssetConsumers(
  clips: readonly TimelineClip[],
  assetId: string | null | undefined,
): number {
  if (!assetId) {
    return 0;
  }

  return clips.reduce((count, clip) => {
    return count + (getBrushMaskAssetId(clip) === assetId ? 1 : 0);
  }, 0);
}

/** Replace mask_ref components while preserving other component types. */
export function setChildMaskClipIds(
  clip: TimelineClip,
  maskClipIds: string[],
): void {
  if (clip.type === "mask") return;
  const existing = getClipComponents(clip);
  const existingMaskRefsById = new Map<string, MaskRefComponent>();
  for (const component of existing) {
    if (component.type === "mask_ref") {
      existingMaskRefsById.set(component.parameters.maskClipId, component);
    }
  }
  const nonMaskRef = existing.filter((component) => component.type !== "mask_ref");
  const uniqueMaskIds = [...new Set(maskClipIds)];
  const maskRefs = uniqueMaskIds.map<MaskRefComponent>((clipId) => {
    const existingRef = existingMaskRefsById.get(clipId);
    if (existingRef) return existingRef;
    return {
      id: crypto.randomUUID(),
      type: "mask_ref",
      parameters: { maskClipId: clipId },
    };
  });
  setClipComponents(clip, [...nonMaskRef, ...maskRefs]);
}

export function addMaskClipComponent(
  clip: TimelineClip,
  maskClipId: string,
): void {
  const currentMaskIds = getChildMaskClipIds(clip);
  if (currentMaskIds.includes(maskClipId)) return;
  setChildMaskClipIds(clip, [...currentMaskIds, maskClipId]);
}

function removeMaskClipComponent(clip: TimelineClip, maskClipId: string): void {
  const currentMaskIds = getChildMaskClipIds(clip);
  setChildMaskClipIds(
    clip,
    currentMaskIds.filter((id) => id !== maskClipId),
  );
}

export function makeMaskClipId(parentClipId: string, maskLocalId: string): string {
  return `${parentClipId}${MASK_CONTEXT_SEPARATOR}${maskLocalId}`;
}

/** Extract { clipId, maskId } from a mask clip's id, or null if not a mask id. */
export function parseMaskClipId(
  id: string,
): { clipId: string; maskId: string } | null {
  const idx = id.indexOf(MASK_CONTEXT_SEPARATOR);
  if (idx <= 0) return null;
  const clipId = id.slice(0, idx);
  const maskId = id.slice(idx + MASK_CONTEXT_SEPARATOR.length);
  if (!clipId || !maskId) return null;
  return { clipId, maskId };
}

export function isInheritedTransformType(
  transformType: ClipTransform["type"],
): boolean {
  return INHERITED_TRANSFORM_TYPES.has(transformType);
}

function getInheritedSpeedTransforms(
  parentClip: TimelineClip,
): ClipTransform[] {
  return (parentClip.transformations || []).filter((transform) =>
    INHERITED_TRANSFORM_TYPES.has(transform.type),
  );
}

function isMaskEdgeTransform(transform: ClipTransform): boolean {
  return MASK_EDGE_TRANSFORM_TYPES.has(transform.type);
}

function getMaskEdgeTransforms(
  transforms: readonly ClipTransform[] | undefined,
): ClipTransform[] {
  return (transforms || []).filter((transform) => isMaskEdgeTransform(transform));
}

function stripMaskEdgeTransforms(
  transforms: readonly ClipTransform[] | undefined,
): ClipTransform[] {
  return (transforms || []).filter((transform) => !isMaskEdgeTransform(transform));
}

function syncMaskEdgeTransformInversion(
  transforms: readonly ClipTransform[] | undefined,
  inverted: boolean,
): ClipTransform[] | undefined {
  if (!transforms || transforms.length === 0) {
    return undefined;
  }

  return transforms.map((transform) => {
    if (!isMaskEdgeTransform(transform)) {
      return structuredClone(transform);
    }

    return {
      ...structuredClone(transform),
      parameters: {
        ...structuredClone(transform.parameters),
        invert: inverted,
      },
    };
  });
}

export function syncMaskEdgeTransformsToAlgebra(
  transforms: readonly ClipTransform[] | undefined,
  algebra: MaskCompositionAlgebra,
): ClipTransform[] {
  return (
    syncMaskEdgeTransformInversion(
      getMaskEdgeTransforms(transforms),
      algebra === "inverse",
    ) ?? []
  );
}

function inferLegacyMaskCompositionAlgebra(
  params: MaskCompositionComponentParameters,
): MaskCompositionAlgebra {
  if (params.algebra) {
    return params.algebra;
  }

  const edgeTransforms = getMaskEdgeTransforms(params.compositeTransformations);
  if (edgeTransforms.length === 0) {
    return DEFAULT_MASK_COMPOSITION_ALGEBRA;
  }

  return edgeTransforms.some((transform) => transform.parameters.invert === true)
    ? "inverse"
    : "normal";
}

function normalizeMaskCompositionParameters(
  params: MaskCompositionComponentParameters,
): MaskCompositionComponentParameters {
  const algebra = inferLegacyMaskCompositionAlgebra(params);
  return {
    ...params,
    algebra,
    compositeTransformations: syncMaskEdgeTransformsToAlgebra(
      params.compositeTransformations,
      algebra,
    ),
  };
}

export function buildMaskClipTransformations(
  maskTransforms: ClipTransform[],
  parentClip: TimelineClip,
): ClipTransform[] {
  const localTransforms = stripMaskEdgeTransforms(maskTransforms);
  const inherited = getInheritedSpeedTransforms(parentClip);
  if (inherited.length === 0) return localTransforms;
  return [...localTransforms, ...inherited];
}

/**
 * Create a mask TimelineClip from mask data + parent clip.
 * Timing is copied from the parent; transforms are the mask's own + inherited speed.
 */
function createMaskClip(
  parentClip: TimelineClip,
  opts: {
    maskLocalId?: string;
    name?: string;
    maskType: ClipMaskType;
    maskMode: ClipMaskMode;
    maskInverted: boolean;
    sam2GrowAmount?: number;
    maskParameters: ClipMaskParameters;
    maskPoints?: ClipMaskPoint[];
    sam2MaskAssetId?: string;
    sam2GeneratedPointsHash?: string;
    sam2LastGeneratedAt?: number;
    generationMaskAssetId?: string;
    brushMaskAssetId?: string;
    brushPaintedBounds?: import("../../../types/TimelineTypes").BrushPaintedBounds;
    activeRange?: MaskActiveRange;
    transformations: ClipTransform[];
  },
): TimelineClip {
  const maskLocalId = opts.maskLocalId ?? crypto.randomUUID();
  return {
    id: makeMaskClipId(parentClip.id, maskLocalId),
    trackId: parentClip.trackId,
    type: "mask",
    name: opts.name ?? `Mask ${maskLocalId}`,
    sourceDuration: parentClip.sourceDuration,
    start: parentClip.start,
    timelineDuration: parentClip.timelineDuration,
    offset: parentClip.offset,
    transformedDuration: parentClip.transformedDuration,
    transformedOffset: parentClip.transformedOffset,
    croppedSourceDuration: parentClip.croppedSourceDuration,
    transformations: buildMaskClipTransformations(
      opts.transformations,
      parentClip,
    ),
    parentClipId: parentClip.id,
    maskType: opts.maskType,
    maskMode: opts.maskMode,
    maskInverted: opts.maskInverted,
    sam2GrowAmount: opts.sam2GrowAmount,
    maskParameters: opts.maskParameters,
    maskPoints: opts.maskPoints ? structuredClone(opts.maskPoints) : undefined,
    sam2MaskAssetId: opts.sam2MaskAssetId,
    sam2GeneratedPointsHash: opts.sam2GeneratedPointsHash,
    sam2LastGeneratedAt: opts.sam2LastGeneratedAt,
    generationMaskAssetId: opts.generationMaskAssetId,
    brushMaskAssetId: opts.brushMaskAssetId,
    brushPaintedBounds: opts.brushPaintedBounds,
    activeRange: opts.activeRange,
  };
}

/** Convert a legacy ClipMask into a mask TimelineClip. */
export function maskToClip(parentClip: TimelineClip, mask: ClipMask): TimelineClip {
  return createMaskClip(parentClip, {
    maskLocalId: mask.id,
    maskType: mask.type,
    maskMode: mask.mode,
    maskInverted: mask.inverted,
    sam2GrowAmount: mask.sam2GrowAmount,
    maskParameters: mask.parameters,
    maskPoints: mask.maskPoints,
    sam2MaskAssetId: mask.sam2MaskAssetId,
    sam2GeneratedPointsHash: mask.sam2GeneratedPointsHash,
    sam2LastGeneratedAt: mask.sam2LastGeneratedAt,
    generationMaskAssetId: mask.generationMaskAssetId,
    brushMaskAssetId: mask.brushMaskAssetId,
    brushPaintedBounds: mask.brushPaintedBounds,
    activeRange: mask.activeRange,
    transformations: mask.transformations ?? [],
  });
}

/**
 * Sync timing fields from a (potentially updated) parent clip onto a mask clip.
 * Returns a new clip object only if something changed.
 */
export function syncMaskTiming(
  maskClip: TimelineClip,
  parent: TimelineClip,
): TimelineClip {
  if (
    maskClip.start === parent.start &&
    maskClip.timelineDuration === parent.timelineDuration &&
    maskClip.offset === parent.offset &&
    maskClip.sourceDuration === parent.sourceDuration &&
    maskClip.transformedDuration === parent.transformedDuration &&
    maskClip.transformedOffset === parent.transformedOffset &&
    maskClip.croppedSourceDuration === parent.croppedSourceDuration &&
    maskClip.trackId === parent.trackId
  ) {
    return maskClip;
  }

  return {
    ...maskClip,
    start: parent.start,
    timelineDuration: parent.timelineDuration,
    offset: parent.offset,
    sourceDuration: parent.sourceDuration,
    transformedDuration: parent.transformedDuration,
    transformedOffset: parent.transformedOffset,
    croppedSourceDuration: parent.croppedSourceDuration,
    trackId: parent.trackId,
  };
}

/** Strip inherited speed transforms, leaving only mask-local transforms. */
function getMaskLocalTransforms(maskClip: TimelineClip): ClipTransform[] {
  return (maskClip.transformations || []).filter(
    (transform) =>
      !INHERITED_TRANSFORM_TYPES.has(transform.type) &&
      !isMaskEdgeTransform(transform),
  );
}

export function migrateLegacyMaskEdgeTransforms(
  clips: TimelineClip[],
  normalizeClip: (clip: TimelineClip) => TimelineClip,
): TimelineClip[] {
  const normalizedClips = clips.map((clip) =>
    normalizeClip(cloneTimelineClip(clip)),
  );
  const clipById = new Map(
    normalizedClips.map((clip) => [clip.id, clip] as const),
  );

  normalizedClips.forEach((clip) => {
    if (clip.type === "mask") {
      const parent = clip.parentClipId ? clipById.get(clip.parentClipId) : null;
      clip.transformations = parent
        ? buildMaskClipTransformations(getMaskLocalTransforms(clip), parent)
        : getMaskLocalTransforms(clip);
      return;
    }

    const parentClip = clip as StandardTimelineClip;
    const childMaskIds = [
      ...new Set([
        ...getChildMaskClipIds(parentClip),
        ...normalizedClips
          .filter(
            (candidate): candidate is MaskTimelineClip =>
              candidate.type === "mask" &&
              candidate.parentClipId === parentClip.id,
          )
          .map((candidate) => candidate.id),
      ]),
    ];
    const childMasks = childMaskIds
      .map((maskId) => clipById.get(maskId))
      .filter(
        (mask): mask is MaskTimelineClip => !!mask && mask.type === "mask",
      );

    const existingComposition = getMaskCompositionComponent(parentClip);
    if (!existingComposition && childMasks.length === 0) {
      return;
    }

    const existingSharedTransforms =
      existingComposition &&
      existingComposition.parameters.compositeTransformations.length > 0
        ? structuredClone(
            existingComposition.parameters.compositeTransformations,
          )
        : undefined;

    const migratedSharedTransforms =
      existingSharedTransforms ??
      childMasks
        .map((maskClip) => {
          const edge = getMaskEdgeTransforms(maskClip.transformations);
          return edge.length > 0 ? structuredClone(edge) : undefined;
        })
        .find(
          (transforms): transforms is ClipTransform[] => !!transforms?.length,
        );
    const migratedAlgebra = existingComposition
      ? inferLegacyMaskCompositionAlgebra(existingComposition.parameters)
      : migratedSharedTransforms?.some(
          (transform) => transform.parameters.invert === true,
        )
        ? "inverse"
        : "normal";

    updateMaskCompositionOnDraft(parentClip, (current) => {
      const nextTransforms = migratedSharedTransforms ?? [];
      if (
        current.expression === undefined &&
        nextTransforms.length === 0 &&
        migratedAlgebra === DEFAULT_MASK_COMPOSITION_ALGEBRA
      ) {
        return null;
      }
      return {
        ...current,
        algebra: migratedAlgebra,
        compositeTransformations: nextTransforms,
      };
    });

    childMasks.forEach((maskClip) => {
      maskClip.transformations = buildMaskClipTransformations(
        getMaskLocalTransforms(maskClip),
        parentClip,
      );
    });
  });

  return normalizedClips;
}

/**
 * Update inherited speed transforms on a mask clip to match a new parent.
 * Only produces a new object when the speed transforms actually differ.
 */
export function syncMaskInheritedSpeed(
  maskClip: TimelineClip,
  parentClip: TimelineClip,
): TimelineClip {
  const localTransforms = getMaskLocalTransforms(maskClip);
  const parentSpeed = getInheritedSpeedTransforms(parentClip);

  const merged =
    parentSpeed.length > 0
      ? [...localTransforms, ...parentSpeed]
      : localTransforms;

  if (
    merged.length === maskClip.transformations.length &&
    parentSpeed.every(
      (transform, i) =>
        maskClip.transformations[localTransforms.length + i] === transform,
    )
  ) {
    return maskClip;
  }

  return { ...maskClip, transformations: merged };
}

/**
 * After a parent clip is updated, propagate timing + speed transforms to all its mask clips.
 * Returns the full clips array with mask clips updated in-place.
 */
export function propagateParentToMasks(
  clips: TimelineClip[],
  parentClip: TimelineClip,
): TimelineClip[] {
  const maskChildIds = new Set(getChildMaskClipIds(parentClip));
  if (maskChildIds.size === 0) return clips;

  return clips.map((clip) => {
    if (!maskChildIds.has(clip.id)) return clip;
    let updated = syncMaskTiming(clip, parentClip);
    updated = syncMaskInheritedSpeed(updated, parentClip);
    return updated;
  });
}

/**
 * Clone a clip and all its child mask clips.
 * Returns [clonedParent, ...clonedMasks].
 */
export function cloneClipWithMasks(
  clip: TimelineClip,
  allClips: TimelineClip[],
  newParentId?: string,
): TimelineClip[] {
  const parentId = newParentId ?? crypto.randomUUID();
  const clonedParent = cloneTimelineClip(clip, parentId);

  const maskChildIds = getChildMaskClipIds(clip);
  const maskChildIdSet = new Set(maskChildIds);
  const childMasks = maskChildIds.length > 0
    ? allClips.filter((candidate) =>
        maskChildIdSet.has(candidate.id) && candidate.type === "mask",
      )
    : [];

  const clonedMaskIds: string[] = [];
  const clonedMasks = childMasks.map((maskClip) => {
    const parsed = parseMaskClipId(maskClip.id);
    const maskLocalId = parsed?.maskId ?? crypto.randomUUID();
    const newMaskId = makeMaskClipId(parentId, maskLocalId);
    clonedMaskIds.push(newMaskId);

    const clonedMask = {
      ...cloneTimelineClip(maskClip, newMaskId),
      parentClipId: parentId,
      trackId: clonedParent.trackId,
    };

    return syncMaskInheritedSpeed(
      syncMaskTiming(clonedMask, clonedParent),
      clonedParent,
    );
  });

  setChildMaskClipIds(clonedParent, clonedMaskIds);

  return [clonedParent, ...clonedMasks];
}

export function collectClipRemovalPlan(
  clips: TimelineClip[],
  clipIds: Iterable<string>,
): {
  clipIdsToRemove: Set<string>;
  sam2MaskAssetIdsToDelete: Set<string>;
} {
  const clipIdsToRemove = new Set<string>();
  const sam2MaskAssetIdsToDelete = new Set<string>();
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));

  for (const clipId of clipIds) {
    const clip = clipById.get(clipId);
    if (!clip) {
      continue;
    }

    clipIdsToRemove.add(clip.id);

    if (clip.type === "mask") {
      for (const backingAssetId of getMaskBackingAssetIds(clip)) {
        sam2MaskAssetIdsToDelete.add(backingAssetId);
      }
      continue;
    }

    for (const maskChildId of getChildMaskClipIds(clip)) {
      clipIdsToRemove.add(maskChildId);
      const maskClip = clipById.get(maskChildId);
      if (maskClip) {
        for (const backingAssetId of getMaskBackingAssetIds(maskClip)) {
          sam2MaskAssetIdsToDelete.add(backingAssetId);
        }
      }
    }
  }

  for (const assetId of [...sam2MaskAssetIdsToDelete]) {
    const hasRemainingConsumer = clips.some((clip) => {
      if (clipIdsToRemove.has(clip.id)) {
        return false;
      }

      return getMaskBackingAssetIds(clip).includes(assetId);
    });

    if (hasRemainingConsumer) {
      sam2MaskAssetIdsToDelete.delete(assetId);
    }
  }

  return {
    clipIdsToRemove,
    sam2MaskAssetIdsToDelete,
  };
}

export function removeClipsFromDraft(
  draft: TimelineModelStateLike,
  clipIdsToRemove: Set<string>,
  trimAndPadTracks: (model: TimelineModelStateLike) => void,
): void {
  if (clipIdsToRemove.size === 0) {
    return;
  }

  const removedClips = draft.clips.filter((clip) => clipIdsToRemove.has(clip.id));
  if (removedClips.length === 0) {
    return;
  }
  const affectedTrackIds = new Set(removedClips.map((clip) => clip.trackId));

  draft.clips = draft.clips.filter((clip) => !clipIdsToRemove.has(clip.id));

  for (const removedClip of removedClips) {
    if (removedClip.type !== "mask") {
      continue;
    }

    const parsed = parseMaskClipId(removedClip.id);
    if (!parsed) {
      continue;
    }

    const parent = draft.clips.find((candidate) => candidate.id === parsed.clipId);
    if (parent) {
      removeMaskClipComponent(parent, removedClip.id);
      if (parent.type !== "mask") {
        const removedMaskId = getMaskLocalId(removedClip);
        if (removedMaskId) {
          updateMaskCompositionOnDraft(parent, (current) => {
            // expression undefined -> legacy auto-union, nothing to prune
            // expression null -> explicitly disabled, nothing to prune
            if (!current.expression) {
              return isMaskCompositionComponentMeaningful(current) ? current : null;
            }
            const prunedExpression = pruneMaskBooleanExpression(
              current.expression,
              [removedMaskId],
            );
            const nextParams: MaskCompositionComponentParameters = {
              ...current,
              expression: prunedExpression,
            };
            return isMaskCompositionComponentMeaningful(nextParams) ? nextParams : null;
          });
        }
      }
    }
  }

  draft.tracks = draft.tracks.map((track) => {
    if (!affectedTrackIds.has(track.id)) {
      return track;
    }

    const hasNonMaskClips = draft.clips.some(
      (clip) => clip.trackId === track.id && clip.type !== "mask",
    );
    return hasNonMaskClips ? track : { ...track, type: undefined };
  });

  trimAndPadTracks(draft);
}
