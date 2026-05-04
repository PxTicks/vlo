import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../../types/TimelineTypes";
import {
  isPointInsideMask,
  type MaskShapeSource,
} from "../../../../masks/model/maskFactory";
import { parseMaskClipId } from "../../../../timeline";
import type { MaskInteractionTarget } from "./maskInteractionTypes";

interface PointLike {
  x: number;
  y: number;
}

export interface FindEditableMaskTargetAtPointInput {
  global: PointLike;
  activeClip: TimelineClip | null;
  masks: readonly MaskTimelineClip[];
  selectedMaskId: string | null;
  toClipLocal: (global: PointLike) => PointLike;
  canEditMask: (maskClip: MaskTimelineClip) => boolean;
  resolveHitShape: (maskClip: MaskTimelineClip) => MaskShapeSource | null;
}

function orderMasksForHitTesting(
  masks: readonly MaskTimelineClip[],
  selectedMaskId: string | null,
): MaskTimelineClip[] {
  const selectedMaskClip = selectedMaskId
    ? masks.find(
        (maskClip) => parseMaskClipId(maskClip.id)?.maskId === selectedMaskId,
      ) ?? null
    : null;

  if (!selectedMaskClip) {
    return [...masks].reverse();
  }

  return [
    selectedMaskClip,
    ...masks
      .filter((maskClip) => maskClip.id !== selectedMaskClip.id)
      .reverse(),
  ];
}

export function findEditableMaskTargetAtPoint({
  global,
  activeClip,
  masks,
  selectedMaskId,
  toClipLocal,
  canEditMask,
  resolveHitShape,
}: FindEditableMaskTargetAtPointInput): MaskInteractionTarget | null {
  if (!activeClip || masks.length === 0) {
    return null;
  }

  const local = toClipLocal(global);
  const orderedMasks = orderMasksForHitTesting(masks, selectedMaskId);

  for (const maskClip of orderedMasks) {
    if (!canEditMask(maskClip)) {
      continue;
    }

    const maskLocalId = parseMaskClipId(maskClip.id)?.maskId ?? null;
    if (!maskLocalId) {
      continue;
    }

    const hitTestShape = resolveHitShape(maskClip);
    if (hitTestShape && isPointInsideMask(local, hitTestShape)) {
      return {
        clipId: activeClip.id,
        maskClip,
        maskLocalId,
      };
    }
  }

  return null;
}
