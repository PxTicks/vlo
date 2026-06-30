import { useSyncExternalStore } from "react";
import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import type { ExtensionPayload } from "../../extensions/types";
import {
  CORE_MONOTONE_INTERPOLATION_ID,
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
} from "../animation";
import type { ScalarParameter, SplinePoint } from "../types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isSplineParameter,
} from "../types";
import { resolveScalar } from "../utils/resolveScalar";

const CORE_VALUE = `interpolation:${CORE_MONOTONE_INTERPOLATION_ID}`;

function payloadFor(
  contribution: Readonly<{
    ownerId: string;
    localId: string;
    definition: Readonly<{ schemaVersion: number; defaultData: ExtensionPayload["data"] }>;
  }>,
): ExtensionPayload {
  return {
    extensionId: contribution.ownerId,
    typeId: contribution.localId,
    schemaVersion: contribution.definition.schemaVersion,
    data: structuredClone(contribution.definition.defaultData),
  };
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

function selectedValue(value: ScalarParameter): string {
  if (isExtensionScalarSourceParameter(value)) {
    return `source:${value.source.extensionId}/${value.source.typeId}`;
  }
  if (isExtensionKeyframedScalarParameter(value)) {
    const outgoing = value.keyframes.find((keyframe) => keyframe.outgoing)?.outgoing;
    if (outgoing) {
      return `interpolation:${outgoing.extensionId}/${outgoing.typeId}`;
    }
  }
  return CORE_VALUE;
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
  useSyncExternalStore(
    (listener) => {
      const unsubscribeSources = extensionScalarSourceRegistry.subscribe(listener);
      const unsubscribeInterpolations =
        extensionInterpolationRegistry.subscribe(listener);
      return () => {
        unsubscribeSources();
        unsubscribeInterpolations();
      };
    },
    () =>
      `${extensionScalarSourceRegistry.getRevision()}:${extensionInterpolationRegistry.getRevision()}`,
    () =>
      `${extensionScalarSourceRegistry.getRevision()}:${extensionInterpolationRegistry.getRevision()}`,
  );

  const sources = extensionScalarSourceRegistry.list();
  const interpolations = extensionInterpolationRegistry.list();
  const hasExtensionChoices =
    sources.length > 0 || interpolations.some(({ ownerId }) => ownerId !== "vlo.core");
  if (!hasExtensionChoices) return null;

  const current = selectedValue(value);
  const knownValues = new Set([
    ...sources.map(({ id }) => `source:${id}`),
    ...interpolations.map(({ id }) => `interpolation:${id}`),
  ]);

  return (
    <FormControl size="small" fullWidth>
      <InputLabel id="animation-source-label">Animation mathematics</InputLabel>
      <Select
        labelId="animation-source-label"
        value={current}
        label="Animation mathematics"
        onChange={(event) => {
          const next = event.target.value;
          if (next.startsWith("source:")) {
            const contribution = sources.find(
              ({ id }) => `source:${id}` === next,
            );
            if (contribution) {
              onChange({ type: "extension-scalar", source: payloadFor(contribution) });
            }
            return;
          }

          const contribution = interpolations.find(
            ({ id }) => `interpolation:${id}` === next,
          );
          if (!contribution) return;
          const points = pointsFor(value, minTime, duration);
          if (contribution.id === CORE_MONOTONE_INTERPOLATION_ID) {
            onChange({ type: "spline", points });
            return;
          }
          const outgoing = payloadFor(contribution);
          onChange({
            type: "extension-keyframed-scalar",
            keyframes: points.map((point, index) => ({
              ...point,
              outgoing: index < points.length - 1 ? structuredClone(outgoing) : undefined,
            })),
          });
        }}
      >
        {!knownValues.has(current) && (
          <MenuItem value={current} disabled>
            Missing extension provider
          </MenuItem>
        )}
        {interpolations.map((contribution) => (
          <MenuItem
            key={`interpolation:${contribution.id}`}
            value={`interpolation:${contribution.id}`}
          >
            {contribution.definition.label} · keyframes
          </MenuItem>
        ))}
        {sources.map((contribution) => (
          <MenuItem
            key={`source:${contribution.id}`}
            value={`source:${contribution.id}`}
          >
            {contribution.definition.label} · source
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
