import { arrayMove } from "@dnd-kit/sortable";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import { isDefaultTransform } from "../../catalogue/TransformationRegistry";

export function insertTransformRespectingDefaultOrder(
  transforms: ClipTransform[],
  transform: ClipTransform,
): ClipTransform[] {
  const nextTransforms = [...transforms];

  if (isDefaultTransform(transform.type)) {
    const firstDynamicIndex = nextTransforms.findIndex(
      (item) => !isDefaultTransform(item.type),
    );

    if (firstDynamicIndex !== -1) {
      nextTransforms.splice(firstDynamicIndex, 0, transform);
      return nextTransforms;
    }
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
