import { arrayMove } from "@dnd-kit/sortable";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import { isDefaultTransform } from "../../catalogue/TransformationRegistry";

// Canonical stacking tiers. Lower ranks sit earlier in the transform array.
// The array order is load-bearing for keyframe domains: `getLayerInputDomain`
// pushes a layer's time through everything *upstream* of it, so a transform's
// authoring domain is warped by any speed transform that precedes it. We keep
// the spatial/value defaults (layout, fitMode, volume) ahead of speed so their
// keyframes stay in the un-warped source domain, and keep speed — itself a
// default section — ahead of the dynamic filters.
function stackingRank(type: string): number {
  if (type === "speed") return 1;
  if (isDefaultTransform(type)) return 0;
  return 2;
}

export function insertTransformRespectingDefaultOrder(
  transforms: ClipTransform[],
  transform: ClipTransform,
): ClipTransform[] {
  const nextTransforms = [...transforms];
  const rank = stackingRank(transform.type);

  // Insert ahead of the first transform that belongs to a later tier; if none
  // exists, append at the end.
  const insertIndex = nextTransforms.findIndex(
    (item) => stackingRank(item.type) > rank,
  );

  if (insertIndex !== -1) {
    nextTransforms.splice(insertIndex, 0, transform);
    return nextTransforms;
  }

  nextTransforms.push(transform);
  return nextTransforms;
}

export function reorderDynamicTransforms(
  transforms: ClipTransform[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
): ClipTransform[] | null {
  const dynamicTransforms = transforms.filter((t) => !isDefaultTransform(t.type));

  const oldIndex = dynamicTransforms.findIndex((t) => t.id === activeId);
  const newIndex = dynamicTransforms.findIndex((t) => t.id === overId);
  if (oldIndex === -1 || newIndex === -1) {
    return null;
  }

  const reorderedDynamic = arrayMove(dynamicTransforms, oldIndex, newIndex);
  const baseTransforms = transforms.filter((t) => isDefaultTransform(t.type));
  return [...baseTransforms, ...reorderedDynamic];
}
