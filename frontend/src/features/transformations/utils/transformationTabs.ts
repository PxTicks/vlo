import type { ClipTransform } from "../../../types/TimelineTypes";
import type { TransformationDefinition } from "../catalogue/types";
import { getEntryForTransform } from "../catalogue/TransformationRegistry";

export type TransformationTabId = "display" | "speed" | "audio" | "color";

export const TRANSFORMATION_TABS: ReadonlyArray<{
  value: TransformationTabId;
  label: string;
}> = [
  { value: "display", label: "Display" },
  { value: "speed", label: "Speed" },
  { value: "audio", label: "Audio" },
  { value: "color", label: "Color" },
];

const COLOR_GRADE_FILTER_NAME = "ColorGradeFilter";

export function getTransformationDefinitionTab(
  definition: TransformationDefinition | undefined,
): TransformationTabId {
  if (!definition) return "display";
  if (definition.type === "speed") return "speed";
  if (definition.compatibleClips === "audio") return "audio";
  if (definition.filterName === COLOR_GRADE_FILTER_NAME) return "color";
  return "display";
}

export function getTransformationTab(
  transform: ClipTransform,
): TransformationTabId {
  return getTransformationDefinitionTab(getEntryForTransform(transform));
}
