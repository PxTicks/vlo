import type { AnyTransform } from "../../types";
import {
  getEntryByFilterName,
  getEntryByType,
} from "../../catalogue/TransformationRegistry";

function extractDefaultParams(typeOrFilterName: string, isFilter: boolean) {
  const params: Record<string, unknown> = {};
  const entry = isFilter
    ? getEntryByFilterName(typeOrFilterName)
    : getEntryByType(typeOrFilterName);

  entry?.uiConfig.groups.forEach((group) => {
    group.controls.forEach((control) => {
      params[control.name] = control.defaultValue;
    });
  });

  return params;
}

export function createAddTransform(
  typeOrFilterName: string,
  isFilter = false,
  isEnabled = true,
): AnyTransform | null {
  if (!typeOrFilterName) {
    return null;
  }

  if (isFilter) {
    return {
      id: crypto.randomUUID(),
      type: "filter",
      filterName: typeOrFilterName,
      isEnabled,
      parameters: extractDefaultParams(typeOrFilterName, true),
    } as AnyTransform;
  }

  return {
    id: crypto.randomUUID(),
    type: typeOrFilterName,
    isEnabled,
    parameters: extractDefaultParams(typeOrFilterName, false),
  } as AnyTransform;
}

export function createCommittedTransform(
  groupId: string,
  parameters: Record<string, unknown>,
): AnyTransform {
  return {
    id: crypto.randomUUID(),
    type: groupId as AnyTransform["type"],
    isEnabled: true,
    parameters,
    ...(groupId === "filter" ? { filterName: "" } : {}),
  } as AnyTransform;
}
