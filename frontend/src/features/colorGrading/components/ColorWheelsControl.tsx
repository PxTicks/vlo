import { useCallback, useEffect, useMemo, useState } from "react";
import { Box } from "@mui/material";
import type { CustomControlRenderProps } from "../../panelUI";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import {
  COLOR_WHEEL_NAMES,
  getWheelParameterNames,
  type ColorWheelName,
} from "../constants";
import { ColorWheel } from "./ColorWheel";
import type { WheelAdjustment } from "../utils/wheelMath";

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readWheel(
  values: Readonly<Record<string, unknown>>,
  wheel: ColorWheelName,
): WheelAdjustment {
  const [r, g, b, master] = getWheelParameterNames(wheel);
  return {
    r: numericValue(values[r]),
    g: numericValue(values[g]),
    b: numericValue(values[b]),
    master: numericValue(values[master]),
  };
}

function wheelUpdate(
  wheel: ColorWheelName,
  value: WheelAdjustment,
): Record<string, number> {
  const [r, g, b, master] = getWheelParameterNames(wheel);
  return { [r]: value.r, [g]: value.g, [b]: value.b, [master]: value.master };
}

export function ColorWheelsControl({
  values,
  onCommitMany,
  transformId,
  disabled,
}: CustomControlRenderProps) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        COLOR_WHEEL_NAMES.map((wheel) => [wheel, readWheel(values, wheel)]),
      ) as Record<ColorWheelName, WheelAdjustment>,
    [values],
  );
  const [wheelValues, setWheelValues] = useState(initial);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWheelValues(initial);
  }, [initial]);

  useEffect(() => {
    if (!transformId) return;
    const unsubscribers = COLOR_WHEEL_NAMES.flatMap((wheel) =>
      getWheelParameterNames(wheel).map((parameterName, channel) =>
        liveParamStore.subscribe(transformId, parameterName, (value) => {
          setWheelValues((current) => ({
            ...current,
            [wheel]: {
              ...current[wheel],
              [["r", "g", "b", "master"][channel]]: value,
            },
          }));
        }),
      ),
    );
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      livePreviewParamStore.clearMany(
        COLOR_WHEEL_NAMES.flatMap((wheel) =>
          getWheelParameterNames(wheel).map((paramName) => ({
            transformId,
            paramName,
          })),
        ),
      );
    };
  }, [transformId]);

  const preview = useCallback(
    (wheel: ColorWheelName, value: WheelAdjustment) => {
      setWheelValues((current) => ({ ...current, [wheel]: value }));
      if (!transformId) return;
      livePreviewParamStore.setMany(
        Object.entries(wheelUpdate(wheel, value)).map(([paramName, nextValue]) => ({
          transformId,
          paramName,
          value: nextValue,
        })),
      );
    },
    [transformId],
  );

  const commit = useCallback(
    (wheel: ColorWheelName, value: WheelAdjustment) => {
      const update = wheelUpdate(wheel, value);
      onCommitMany(update);
      if (transformId) {
        livePreviewParamStore.clearMany(
          Object.keys(update).map((paramName) => ({ transformId, paramName })),
        );
      }
    },
    [onCommitMany, transformId],
  );

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(112px, 1fr))", gap: 1.5 }}>
      {COLOR_WHEEL_NAMES.map((wheel) => (
        <ColorWheel
          key={wheel}
          label={wheel[0].toUpperCase() + wheel.slice(1)}
          value={wheelValues[wheel]}
          maxChroma={wheel === "offset" || wheel === "lift" ? 0.3 : 0.5}
          maxMaster={wheel === "offset" || wheel === "lift" ? 0.5 : 1}
          disabled={disabled}
          onPreview={(value) => preview(wheel, value)}
          onCommit={(value) => commit(wheel, value)}
        />
      ))}
    </Box>
  );
}
