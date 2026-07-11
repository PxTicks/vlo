import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Box, Button, Collapse, Typography } from "@mui/material";
import { ExpandMore } from "@mui/icons-material";
import type { CustomControlRenderProps } from "../../panelUI";
import { SliderControl } from "../../panelUI";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import { TONE_SHAPING_PARAMETER_CONTROLS } from "../constants";
import {
  highlightRolloffStrength,
  shadowLiftStrength,
  toneMacroUpdate,
  type ToneMacro,
  type ToneParameters,
} from "../utils/toneShaping";

function finiteValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readToneParameters(
  values: Readonly<Record<string, unknown>>,
): ToneParameters {
  return {
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParameters(initial);
  }, [initial]);

  useEffect(() => {
    if (!transformId) return;
    const unsubscribers = TONE_SHAPING_PARAMETER_CONTROLS.map((control) =>
      liveParamStore.subscribe(transformId, control.name, (value) => {
        setParameters((current) => ({ ...current, [control.name]: value }));
      }),
    );
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      livePreviewParamStore.clearMany(
        TONE_SHAPING_PARAMETER_CONTROLS.map((control) => ({
          transformId,
          paramName: control.name,
        })),
      );
    };
  }, [transformId]);

  const preview = useCallback(
    (macro: ToneMacro, strength: number) => {
      const update = toneMacroUpdate(macro, strength);
      setParameters((current) => ({ ...current, ...update }));
      if (!transformId) return;
      livePreviewParamStore.setMany(
        Object.entries(update).map(([paramName, value]) => ({
          transformId,
          paramName,
          value,
        })),
      );
    },
    [transformId],
  );

  const commit = useCallback(
    (macro: ToneMacro, strength: number) => {
      const update = toneMacroUpdate(macro, strength);
      setParameters((current) => ({ ...current, ...update }));
      onCommitMany(update);
      if (!transformId) return;
      livePreviewParamStore.clearMany(
        Object.keys(update).map((paramName) => ({ transformId, paramName })),
      );
    },
    [onCommitMany, transformId],
  );

  const macros = [
    {
      key: "highlight" as const,
      label: "Highlight rolloff",
      value: highlightRolloffStrength(parameters),
    },
    {
      key: "shadow" as const,
      label: "Shadow lift",
      value: shadowLiftStrength(parameters),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: "grid", gap: 1 }}>
        {macros.map((macro) => (
          <SliderControl
            key={macro.key}
            label={macro.label}
            value={macro.value}
            min={0}
            max={1}
            step={0.01}
            disabled={disabled}
            onChange={(_event, value) => preview(macro.key, value as number)}
            onChangeCommitted={(_event, value) =>
              commit(macro.key, value as number)
            }
            onInputCommit={(value) => commit(macro.key, value)}
          />
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled", px: 1 }}>
        Quick controls: each slider drives a linked parameter pair. Rolloff
        compresses pushed highlights; shadow lift raises the black floor.
      </Typography>
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
                <Typography variant="caption" sx={{ color: "text.disabled", px: 1 }}>
                  These are the exact values driven by the quick controls.
                  Threshold and amount are inactive when their transition is
                  zero; use these controls for precise values and keyframes.
                </Typography>
                {TONE_SHAPING_PARAMETER_CONTROLS.map((control) => (
                  <Box key={control.name}>{renderParameterControl(control)}</Box>
                ))}
              </Box>
            ) : null}
          </Collapse>
        </Box>
      ) : null}
    </Box>
  );
}
