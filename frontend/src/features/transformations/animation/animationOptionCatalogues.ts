import type { JsonValue } from "@vlo/extension-sdk";
import {
  hostOptionCatalog,
  type CatalogueOptionEntry,
} from "../../../core/shell/optionCatalog";
import type { ShellDisposable } from "../../../core/shell/hostMenuCatalog";

export const ANIMATION_SCALAR_SOURCES_CATALOGUE =
  "animation.scalar-sources";
export const ANIMATION_INTERPOLATIONS_CATALOGUE =
  "animation.interpolations";
export const CORE_MONOTONE_PROVIDER_ID = "vlo.core/monotone-cubic";

export interface AnimationCatalogueValue {
  readonly providerId: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
}

function isAnimationCatalogueValue(
  value: unknown,
): value is AnimationCatalogueValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    providerId?: unknown;
    schemaVersion?: unknown;
    defaultData?: unknown;
  };
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.includes("/") &&
    Number.isInteger(candidate.schemaVersion) &&
    Number(candidate.schemaVersion) > 0 &&
    candidate.defaultData !== undefined
  );
}

let declared = false;

/** Declares the two animation-provider catalogues before extensions activate. */
export function declareAnimationOptionCatalogues(): void {
  if (declared) return;
  declared = true;
  const valueSchema = {
    providerId: "owner-qualified string",
    schemaVersion: "positive integer",
    defaultData: "JsonValue",
  } as const;
  hostOptionCatalog.declare({
    id: ANIMATION_SCALAR_SOURCES_CATALOGUE,
    validateValue: isAnimationCatalogueValue,
    valueSchema,
  });
  hostOptionCatalog.declare({
    id: ANIMATION_INTERPOLATIONS_CATALOGUE,
    validateValue: isAnimationCatalogueValue,
    valueSchema,
  });
  hostOptionCatalog.registerHostOption(ANIMATION_INTERPOLATIONS_CATALOGUE, {
    id: "monotone-cubic",
    label: "Monotone cubic",
    value: {
      providerId: CORE_MONOTONE_PROVIDER_ID,
      schemaVersion: 1,
      defaultData: null,
    },
  });
}

/** Projects an executable animation registration into its selector catalogue. */
export function registerAnimationCatalogueOption(
  catalogueId:
    | typeof ANIMATION_SCALAR_SOURCES_CATALOGUE
    | typeof ANIMATION_INTERPOLATIONS_CATALOGUE,
  option: {
    readonly id: string;
    readonly label: string;
    readonly schemaVersion: number;
    readonly defaultData: JsonValue;
  },
): ShellDisposable {
  return hostOptionCatalog.registerContributedOption(catalogueId, {
    id: option.id,
    label: option.label,
    value: {
      providerId: option.id,
      schemaVersion: option.schemaVersion,
      defaultData: option.defaultData,
    },
  });
}

export function readAnimationCatalogueValue(
  option: CatalogueOptionEntry,
): AnimationCatalogueValue | null {
  return isAnimationCatalogueValue(option.value) ? option.value : null;
}

