import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ExpandMore } from "@mui/icons-material";
import { Box, Button, Collapse, Typography } from "@mui/material";
import {
  useLiveParameterPreviewSession,
  type CustomControlRenderProps,
} from "../../panelUI";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";
import {
  COLOR_WHEEL_NAMES,
  getWheelParameterNames,
  getWheelParameterControls,
  type ColorWheelName,
} from "../constants";
import { ColorWheel } from "./ColorWheel";
import type { WheelAdjustment } from "../utils/wheelMath";

const COLOR_WHEEL_GRID_STACK_BREAKPOINT_PX = 280;

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
  renderParameterControl,
}: CustomControlRenderProps) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        COLOR_WHEEL_NAMES.map((wheel) => [wheel, readWheel(values, wheel)]),
      ) as Record<ColorWheelName, WheelAdjustment>,
    [values],
  );
  const [wheelValues, setWheelValues] = useState(initial);
  const [showChannelAnimation, setShowChannelAnimation] = useState(false);
  const channelAnimationId = useId();
  const {
    preview: previewParameters,
    commit: commitParameters,
  } = useLiveParameterPreviewSession({ transformId, onCommitMany });

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
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [transformId]);

  const preview = useCallback(
    (wheel: ColorWheelName, value: WheelAdjustment) => {
      setWheelValues((current) => ({ ...current, [wheel]: value }));
      previewParameters(wheelUpdate(wheel, value));
    },
    [previewParameters],
  );

  const commit = useCallback(
    (wheel: ColorWheelName, value: WheelAdjustment) => {
      const update = wheelUpdate(wheel, value);
      commitParameters(update);
    },
    [commitParameters],
  );

  return (
    <Box sx={{ containerType: "inline-size", minWidth: 0 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 1.5,
          minWidth: 0,
          [`@container (max-width: ${COLOR_WHEEL_GRID_STACK_BREAKPOINT_PX - 1}px)`]: {
            gridTemplateColumns: "minmax(0, 1fr)",
          },
        }}
      >
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
      {renderParameterControl ? (
        <Box sx={{ mt: 1 }}>
          <Button
            size="small"
            color="inherit"
            onClick={() => setShowChannelAnimation((current) => !current)}
            endIcon={
              <ExpandMore
                sx={{
                  transform: showChannelAnimation
                    ? "rotate(180deg)"
                    : "rotate(0deg)",
                  transition: "transform 150ms ease",
                }}
              />
            }
            aria-expanded={showChannelAnimation}
            aria-controls={channelAnimationId}
            sx={{ color: "text.secondary", px: 0.5 }}
          >
            Channel animation
          </Button>
          <Collapse in={showChannelAnimation} unmountOnExit>
            {showChannelAnimation ? (
              <Box
                id={channelAnimationId}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 1.5,
                  pt: 1,
                  minWidth: 0,
                  [`@container (max-width: ${COLOR_WHEEL_GRID_STACK_BREAKPOINT_PX - 1}px)`]: {
                    gridTemplateColumns: "minmax(0, 1fr)",
                  },
                }}
              >
                {COLOR_WHEEL_NAMES.map((wheel) => (
                  <Box key={wheel} sx={{ display: "grid", gap: 0.75 }}>
                    <Typography variant="caption" color="text.secondary">
                      {wheel[0].toUpperCase() + wheel.slice(1)} channels
                    </Typography>
                    {getWheelParameterControls(wheel).map((control) => (
                      <Box key={control.name}>
                        {renderParameterControl(control)}
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            ) : null}
          </Collapse>
        </Box>
      ) : null}
    </Box>
  );
}
