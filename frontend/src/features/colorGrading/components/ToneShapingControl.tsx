import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Box, Button, Collapse, Typography } from "@mui/material";
import { ExpandMore } from "@mui/icons-material";
import {
  useLiveParameterPreviewSession,
  type CustomControlRenderProps,
} from "../../panelUI";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import { TONE_SHAPING_PARAMETER_CONTROLS } from "../constants";
import type { ToneGraphParameters, ToneParameters } from "../utils/toneShaping";
import { ToneResponseGraph } from "./ToneResponseGraph";

function finiteValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readToneParameters(
  values: Readonly<Record<string, unknown>>,
): ToneGraphParameters {
  return {
    contrast: finiteValue(values.contrast, 1),
    pivot: finiteValue(values.pivot, 0.435),
    kneeThreshold: finiteValue(values.kneeThreshold, 1),
    kneeSoftness: finiteValue(values.kneeSoftness, 0),
    toeAmount: finiteValue(values.toeAmount, 0),
    toeSoftness: finiteValue(values.toeSoftness, 0),
  };
}

export function ToneShapingControl({
  values,
  onCommitMany,
  transformId,
  disabled,
  renderParameterControl,
}: CustomControlRenderProps) {
  const initial = useMemo(() => readToneParameters(values), [values]);
  const [parameters, setParameters] = useState(initial);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedId = useId();
  const {
    preview: previewParameters,
    commit: commitParameters,
    cancel: cancelParameters,
  } = useLiveParameterPreviewSession({ transformId, onCommitMany });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParameters(initial);
  }, [initial]);

  useEffect(() => {
    if (!transformId) return;
    const parameterNames = [
      "contrast",
      "pivot",
      ...TONE_SHAPING_PARAMETER_CONTROLS.map((control) => control.name),
    ];
    const unsubscribers = parameterNames.map((parameterName) =>
      liveParamStore.subscribe(transformId, parameterName, (value) => {
        setParameters((current) => ({ ...current, [parameterName]: value }));
      }),
    );
    livePreviewParamStore.requestRender();
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [transformId]);

  const preview = useCallback(
    (update: Partial<ToneParameters>) => {
      setParameters((current) => ({ ...current, ...update }));
      previewParameters(update);
    },
    [previewParameters],
  );

  const commit = useCallback(
    (update: Partial<ToneParameters>) => {
      setParameters((current) => ({ ...current, ...update }));
      commitParameters(update);
    },
    [commitParameters],
  );

  const cancel = useCallback(
    (start: ToneParameters) => {
      setParameters((current) => ({ ...current, ...start }));
      cancelParameters();
    },
    [cancelParameters],
  );

  return (
    <Box>
      <ToneResponseGraph
        parameters={parameters}
        disabled={disabled}
        onPreview={preview}
        onCommit={commit}
        onCancel={cancel}
      />
      {renderParameterControl ? (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            color="inherit"
            onClick={() => setShowAdvanced((current) => !current)}
            endIcon={
              <ExpandMore
                sx={{
                  transform: showAdvanced ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 150ms ease",
                }}
              />
            }
            aria-expanded={showAdvanced}
            aria-controls={advancedId}
            sx={{ color: "text.secondary", px: 0.5 }}
          >
            Exact parameters / animation
          </Button>
          <Collapse in={showAdvanced} unmountOnExit>
            {showAdvanced ? (
              <Box id={advancedId} sx={{ display: "grid", gap: 0.75, pt: 1 }}>
                <Typography
                  variant="caption"
                  sx={{ color: "text.disabled", px: 1 }}
                >
                  These are the exact values driven by the handles above.
                  Threshold and amount are inactive when their transition is
                  zero; use these controls for precise values and keyframes.
                </Typography>
                {TONE_SHAPING_PARAMETER_CONTROLS.map((control) => (
                  <Box key={control.name}>
                    {renderParameterControl(control)}
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
