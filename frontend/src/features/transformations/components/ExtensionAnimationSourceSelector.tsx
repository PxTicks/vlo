import { useSyncExternalStore } from "react";
import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { hostContextKeys } from "../../../core/shell/contextKeys";
import {
  hostOptionCatalog,
  type CatalogueOptionEntry,
} from "../../../core/shell/optionCatalog";
import type { ExtensionPayload } from "../../extensions/types";
import {
  ANIMATION_INTERPOLATIONS_CATALOGUE,
  ANIMATION_SCALAR_SOURCES_CATALOGUE,
  CORE_MONOTONE_INTERPOLATION_ID,
} from "../animation";
import { readAnimationCatalogueValue } from "../animation/animationOptionCatalogues";
import type { ScalarParameter, SplinePoint } from "../types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isSplineParameter,
} from "../types";
import { resolveScalar } from "../utils/resolveScalar";

const INTERPOLATION_PREFIX = "interpolation:";
const SOURCE_PREFIX = "source:";

function payloadFor(option: CatalogueOptionEntry): ExtensionPayload | null {
  const value = readAnimationCatalogueValue(option);
  if (!value) return null;
  const separator = value.providerId.indexOf("/");
  if (separator <= 0 || separator === value.providerId.length - 1) return null;
  return {
    extensionId: value.providerId.slice(0, separator),
    typeId: value.providerId.slice(separator + 1),
    schemaVersion: value.schemaVersion,
    data: structuredClone(value.defaultData),
  };
}

function providerId(option: CatalogueOptionEntry): string | null {
  return readAnimationCatalogueValue(option)?.providerId ?? null;
}

function pointsFor(
  value: ScalarParameter,
  minTime: number,
  duration: number,
): SplinePoint[] {
  if (isSplineParameter(value)) return structuredClone(value.points);
  if (isExtensionKeyframedScalarParameter(value)) {
    return value.keyframes.map(({ time, value: pointValue }) => ({
      time,
      value: pointValue,
    }));
  }
  return [
    { time: minTime, value: resolveScalar(value, minTime) },
    {
      time: minTime + duration,
      value: resolveScalar(value, minTime + duration),
    },
  ];
}

function selectedProvider(value: ScalarParameter): {
  readonly kind: "source" | "interpolation";
  readonly id: string;
} {
  if (isExtensionScalarSourceParameter(value)) {
    return {
      kind: "source",
      id: `${value.source.extensionId}/${value.source.typeId}`,
    };
  }
  if (isExtensionKeyframedScalarParameter(value)) {
    const outgoing = value.keyframes.find(
      (keyframe) => keyframe.outgoing,
    )?.outgoing;
    if (outgoing) {
      return {
        kind: "interpolation",
        id: `${outgoing.extensionId}/${outgoing.typeId}`,
      };
    }
  }
  return { kind: "interpolation", id: CORE_MONOTONE_INTERPOLATION_ID };
}

function useAnimationOptions(): {
  readonly sources: readonly CatalogueOptionEntry[];
  readonly interpolations: readonly CatalogueOptionEntry[];
} {
  useSyncExternalStore(
    (listener) => hostOptionCatalog.subscribe(listener),
    () => hostOptionCatalog.getRevision(),
    () => hostOptionCatalog.getRevision(),
  );
  useSyncExternalStore(
    (listener) => hostContextKeys.subscribe(listener),
    () => hostContextKeys.getRevision(),
    () => hostContextKeys.getRevision(),
  );
  return {
    sources: hostOptionCatalog.resolveOptions(
      ANIMATION_SCALAR_SOURCES_CATALOGUE,
    ),
    interpolations: hostOptionCatalog.resolveOptions(
      ANIMATION_INTERPOLATIONS_CATALOGUE,
    ),
  };
}

export interface ExtensionAnimationSourceSelectorProps {
  readonly value: ScalarParameter;
  readonly minTime: number;
  readonly duration: number;
  readonly onChange: (value: ScalarParameter) => void;
}

export function ExtensionAnimationSourceSelector({
  value,
  minTime,
  duration,
  onChange,
}: ExtensionAnimationSourceSelectorProps) {
  const { sources, interpolations } = useAnimationOptions();
  const hasExtensionChoices =
    sources.length > 0 ||
    interpolations.some(
      (option) => providerId(option) !== CORE_MONOTONE_INTERPOLATION_ID,
    );
  if (!hasExtensionChoices) return null;

  const selected = selectedProvider(value);
  const currentOption =
    (selected.kind === "source" ? sources : interpolations).find(
      (option) => providerId(option) === selected.id,
    ) ?? null;
  const current = currentOption
    ? `${selected.kind === "source" ? SOURCE_PREFIX : INTERPOLATION_PREFIX}${currentOption.id}`
    : `missing:${selected.kind}:${selected.id}`;

  return (
    <FormControl size="small" fullWidth>
      <InputLabel id="animation-source-label">Animation mathematics</InputLabel>
      <Select
        labelId="animation-source-label"
        value={current}
        label="Animation mathematics"
        onChange={(event) => {
          const next = event.target.value;
          const isSource = next.startsWith(SOURCE_PREFIX);
          const prefix = isSource ? SOURCE_PREFIX : INTERPOLATION_PREFIX;
          const option = (isSource ? sources : interpolations).find(
            (candidate) => candidate.id === next.slice(prefix.length),
          );
          if (!option) return;
          const payload = payloadFor(option);
          if (!payload) return;
          if (isSource) {
            onChange({ type: "extension-scalar", source: payload });
            return;
          }
          const points = pointsFor(value, minTime, duration);
          if (
            `${payload.extensionId}/${payload.typeId}` ===
            CORE_MONOTONE_INTERPOLATION_ID
          ) {
            onChange({ type: "spline", points });
            return;
          }
          onChange({
            type: "extension-keyframed-scalar",
            keyframes: points.map((point, index) => ({
              ...point,
              outgoing:
                index < points.length - 1
                  ? structuredClone(payload)
                  : undefined,
            })),
          });
        }}
      >
        {!currentOption ? (
          <MenuItem value={current} disabled>
            Missing extension provider
          </MenuItem>
        ) : null}
        {interpolations.map((option) => (
          <MenuItem
            key={`${INTERPOLATION_PREFIX}${option.id}`}
            value={`${INTERPOLATION_PREFIX}${option.id}`}
          >
            {option.label} · keyframes
          </MenuItem>
        ))}
        {sources.map((option) => (
          <MenuItem
            key={`${SOURCE_PREFIX}${option.id}`}
            value={`${SOURCE_PREFIX}${option.id}`}
          >
            {option.label} · source
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
