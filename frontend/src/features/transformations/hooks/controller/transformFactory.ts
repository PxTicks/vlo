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

  // A definition that handles several transform types (layout: position /
  // scale / rotation) keys each type's controls by its group id; taking every
  // group would let scale's x/y defaults overwrite position's.
  const ownGroup =
    !isFilter && entry && entry.type !== typeOrFilterName
      ? entry.uiConfig.groups.find((group) => group.id === typeOrFilterName)
      : undefined;
  const groups = ownGroup ? [ownGroup] : (entry?.uiConfig.groups ?? []);

  groups.forEach((group) => {
    group.controls.forEach((control) => {
      if (control.type === "custom" || control.type === "spacer") return;
      params[control.name] = control.defaultValue;
    });
  });
  if (entry?.defaultParameters) {
    Object.assign(params, structuredClone(entry.defaultParameters));
  }

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
