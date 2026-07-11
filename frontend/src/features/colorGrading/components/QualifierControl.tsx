import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Switch,
  Typography,
} from "@mui/material";
import { Colorize } from "@mui/icons-material";
import {
  circularHueWeight,
  DEFAULT_COLOR_QUALIFIER,
  rgbToHsv,
  softTrapezoidWeight,
  type ColorQualifierParameters,
} from "../../../core/color";
import { liveParamStore } from "../../../core/liveParams/liveParamStore";
import {
  useLiveParameterPreviewSession,
  type CustomControlRenderProps,
} from "../../panelUI";
import { QUALIFIER_PARAMETER_CONTROLS } from "../constants";
import { pickColorFromViewer } from "../services/viewerColorPicker";
import {
  QualifierRangeBar,
  type QualifierBoundaryId,
  type QualifierRangeBoundary,
} from "./QualifierRangeBar";

type NumericQualifierName = Exclude<
  keyof ColorQualifierParameters,
  "qualifierEnabled" | "qualifierInvert" | "mattePreview"
>;

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readParameters(
  values: Readonly<Record<string, unknown>>,
): ColorQualifierParameters {
  return {
    qualifierEnabled:
      typeof values.qualifierEnabled === "boolean"
        ? values.qualifierEnabled
        : DEFAULT_COLOR_QUALIFIER.qualifierEnabled,
    qualifierInvert:
      typeof values.qualifierInvert === "boolean"
        ? values.qualifierInvert
        : DEFAULT_COLOR_QUALIFIER.qualifierInvert,
    mattePreview:
      typeof values.mattePreview === "boolean"
        ? values.mattePreview
        : DEFAULT_COLOR_QUALIFIER.mattePreview,
    hueCenter: numeric(values.hueCenter, DEFAULT_COLOR_QUALIFIER.hueCenter),
    hueWidth: numeric(values.hueWidth, DEFAULT_COLOR_QUALIFIER.hueWidth),
    hueSoftLo: numeric(values.hueSoftLo, DEFAULT_COLOR_QUALIFIER.hueSoftLo),
    hueSoftHi: numeric(values.hueSoftHi, DEFAULT_COLOR_QUALIFIER.hueSoftHi),
    satLo: numeric(values.satLo, DEFAULT_COLOR_QUALIFIER.satLo),
    satHi: numeric(values.satHi, DEFAULT_COLOR_QUALIFIER.satHi),
    satSoftLo: numeric(values.satSoftLo, DEFAULT_COLOR_QUALIFIER.satSoftLo),
    satSoftHi: numeric(values.satSoftHi, DEFAULT_COLOR_QUALIFIER.satSoftHi),
    lumaLo: numeric(values.lumaLo, DEFAULT_COLOR_QUALIFIER.lumaLo),
    lumaHi: numeric(values.lumaHi, DEFAULT_COLOR_QUALIFIER.lumaHi),
    lumaSoftLo: numeric(values.lumaSoftLo, DEFAULT_COLOR_QUALIFIER.lumaSoftLo),
    lumaSoftHi: numeric(values.lumaSoftHi, DEFAULT_COLOR_QUALIFIER.lumaSoftHi),
  };
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function nearestEquivalent(value: number, reference: number): number {
  return value + Math.round(reference - value);
}

function hueDisplayPosition(value: number, center: number): number {
  const displayCenter = wrap(center + 0.5);
  let position = displayCenter + (value - center);
  if (position < 0) position += 1;
  if (position > 1) position -= 1;
  return position;
}

export function QualifierControl({
  values,
  onCommitMany,
  transformId,
  disabled,
}: CustomControlRenderProps) {
  const initial = useMemo(() => readParameters(values), [values]);
  const [parameters, setParameters] = useState(initial);
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);
  const {
    begin: beginInteraction,
    preview: previewChanges,
    commit: commitChanges,
  } = useLiveParameterPreviewSession({ transformId, onCommitMany });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParameters(initial);
  }, [initial]);

  useEffect(() => {
    if (!transformId) return;
    const numericNames = QUALIFIER_PARAMETER_CONTROLS.filter(
      (control) => control.type === "number",
    ).map((control) => control.name as NumericQualifierName);
    const unsubscribers = numericNames.map((name) =>
      liveParamStore.subscribe(transformId, name, (value) => {
        setParameters((current) => ({ ...current, [name]: value }));
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [transformId]);

  const update = useCallback(
    (changes: Partial<ColorQualifierParameters>, commit: boolean) => {
      setParameters((current) => ({ ...current, ...changes }));
      if (commit) {
        commitChanges(changes);
      } else {
        previewChanges(changes);
      }
    },
    [commitChanges, previewChanges],
  );

  const commitInteraction = useCallback(
    () => commitChanges(),
    [commitChanges],
  );

  const changeHue = (
    boundary: QualifierBoundaryId,
    position: number,
    commit: boolean,
  ): void => {
    const halfWidth = parameters.hueWidth / 2;
    const innerLow = parameters.hueCenter - halfWidth;
    const innerHigh = parameters.hueCenter + halfWidth;
    const outerLow = innerLow - parameters.hueSoftLo;
    const outerHigh = innerHigh + parameters.hueSoftHi;
    const current = { outerLow, innerLow, innerHigh, outerHigh }[boundary];
    const hue = wrap(position - 0.5);
    const target = nearestEquivalent(hue, current);

    if (boundary === "outerLow") {
      if (target <= innerLow) {
        update(
          { hueSoftLo: Math.min(0.5, innerLow - target) },
          commit,
        );
      } else {
        const nextLow = Math.min(innerHigh - 0.002, target);
        update(
          {
            hueCenter: wrap((nextLow + innerHigh) / 2),
            hueWidth: innerHigh - nextLow,
            hueSoftLo: 0,
          },
          commit,
        );
      }
    } else if (boundary === "innerLow") {
      const nextLow = Math.max(
        innerHigh - 1,
        Math.min(innerHigh - 0.002, target),
      );
      update(
        {
          hueCenter: wrap((nextLow + innerHigh) / 2),
          hueWidth: innerHigh - nextLow,
          hueSoftLo: Math.min(0.5, nextLow - Math.min(outerLow, nextLow)),
        },
        commit,
      );
    } else if (boundary === "innerHigh") {
      const nextHigh = Math.min(
        innerLow + 1,
        Math.max(innerLow + 0.002, target),
      );
      update(
        {
          hueCenter: wrap((innerLow + nextHigh) / 2),
          hueWidth: nextHigh - innerLow,
          hueSoftHi: Math.min(0.5, Math.max(outerHigh, nextHigh) - nextHigh),
        },
        commit,
      );
    } else {
      if (target >= innerHigh) {
        update(
          { hueSoftHi: Math.min(0.5, target - innerHigh) },
          commit,
        );
      } else {
        const nextHigh = Math.max(innerLow + 0.002, target);
        update(
          {
            hueCenter: wrap((innerLow + nextHigh) / 2),
            hueWidth: nextHigh - innerLow,
            hueSoftHi: 0,
          },
          commit,
        );
      }
    }
  };

  const changeLinear = (
    kind: "sat" | "luma",
    boundary: QualifierBoundaryId,
    value: number,
    commit: boolean,
  ): void => {
    const lowName = `${kind}Lo` as "satLo" | "lumaLo";
    const highName = `${kind}Hi` as "satHi" | "lumaHi";
    const softLowName = `${kind}SoftLo` as "satSoftLo" | "lumaSoftLo";
    const softHighName = `${kind}SoftHi` as "satSoftHi" | "lumaSoftHi";
    const low = parameters[lowName];
    const high = parameters[highName];
    const outerLow = Math.max(0, low - parameters[softLowName]);
    const outerHigh = Math.min(1, high + parameters[softHighName]);
    if (boundary === "outerLow") {
      if (value <= low) {
        update({ [softLowName]: low - value }, commit);
      } else {
        update(
          {
            [lowName]: Math.min(value, high),
            [softLowName]: 0,
          },
          commit,
        );
      }
    } else if (boundary === "innerLow") {
      const nextLow = Math.max(0, Math.min(value, high));
      update(
        {
          [lowName]: nextLow,
          [softLowName]: nextLow - Math.min(outerLow, nextLow),
        },
        commit,
      );
    } else if (boundary === "innerHigh") {
      const nextHigh = Math.min(1, Math.max(value, low));
      update(
        {
          [highName]: nextHigh,
          [softHighName]: Math.max(outerHigh, nextHigh) - nextHigh,
        },
        commit,
      );
    } else {
      if (value >= high) {
        update({ [softHighName]: value - high }, commit);
      } else {
        update(
          {
            [highName]: Math.max(value, low),
            [softHighName]: 0,
          },
          commit,
        );
      }
    }
  };

  const shiftLinearRange = (
    kind: "sat" | "luma",
    delta: number,
    commit: boolean,
  ): void => {
    const lowName = `${kind}Lo` as "satLo" | "lumaLo";
    const highName = `${kind}Hi` as "satHi" | "lumaHi";
    const softLowName = `${kind}SoftLo` as "satSoftLo" | "lumaSoftLo";
    const softHighName = `${kind}SoftHi` as "satSoftHi" | "lumaSoftHi";
    const low = parameters[lowName];
    const high = parameters[highName];
    const outerLow = Math.max(0, low - parameters[softLowName]);
    const outerHigh = Math.min(1, high + parameters[softHighName]);
    const boundedDelta = Math.max(-outerLow, Math.min(1 - outerHigh, delta));
    update(
      {
        [lowName]: low + boundedDelta,
        [highName]: high + boundedDelta,
      },
      commit,
    );
  };

  const pick = async (): Promise<void> => {
    setPickerMessage("Click a colour in the viewer · Esc to cancel");
    try {
      const color = await pickColorFromViewer();
      const hsv = rgbToHsv(color);
      const luma = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
      update(
        {
          qualifierEnabled: true,
          hueCenter: hsv[0],
          hueWidth: 0.12,
          hueSoftLo: 0.06,
          hueSoftHi: 0.06,
          satLo: Math.max(0, hsv[1] - 0.2),
          satHi: Math.min(1, hsv[1] + 0.2),
          satSoftLo: 0.1,
          satSoftHi: 0.1,
          lumaLo: Math.max(0, luma - 0.15),
          lumaHi: Math.min(1, luma + 0.15),
          lumaSoftLo: 0.1,
          lumaSoftHi: 0.1,
        },
        true,
      );
      setPickerMessage(null);
    } catch (error) {
      setPickerMessage(error instanceof Error ? error.message : "Could not sample viewer");
    }
  };

  const halfWidth = parameters.hueWidth / 2;
  const hueInnerLow = parameters.hueCenter - halfWidth;
  const hueInnerHigh = parameters.hueCenter + halfWidth;
  const hueIsFullRange = parameters.hueWidth >= 0.999;
  const hueBoundaries: readonly QualifierRangeBoundary[] = [
    {
      id: "outerLow",
      value: wrap(hueInnerLow - parameters.hueSoftLo),
      position: hueIsFullRange
        ? 0
        : hueDisplayPosition(
            hueInnerLow - parameters.hueSoftLo,
            parameters.hueCenter,
          ),
    },
    {
      id: "innerLow",
      value: wrap(hueInnerLow),
      position: hueIsFullRange
        ? 0
        : hueDisplayPosition(hueInnerLow, parameters.hueCenter),
    },
    {
      id: "innerHigh",
      value: wrap(hueInnerHigh),
      position: hueIsFullRange
        ? 1
        : hueDisplayPosition(hueInnerHigh, parameters.hueCenter),
    },
    {
      id: "outerHigh",
      value: wrap(hueInnerHigh + parameters.hueSoftHi),
      position: hueIsFullRange
        ? 1
        : hueDisplayPosition(
            hueInnerHigh + parameters.hueSoftHi,
            parameters.hueCenter,
          ),
    },
  ];
  const linearBoundaries = (
    low: number,
    high: number,
    softLow: number,
    softHigh: number,
  ): readonly QualifierRangeBoundary[] => [
    { id: "outerLow", value: Math.max(0, low - softLow), position: Math.max(0, low - softLow) },
    { id: "innerLow", value: low, position: low },
    { id: "innerHigh", value: high, position: high },
    { id: "outerHigh", value: Math.min(1, high + softHigh), position: Math.min(1, high + softHigh) },
  ];
  const controlsDisabled = disabled || !parameters.qualifierEnabled;
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 1 }}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={parameters.qualifierEnabled}
              disabled={disabled}
              onChange={(_, checked) => update({ qualifierEnabled: checked, mattePreview: checked ? parameters.mattePreview : false }, true)}
            />
          }
          label="Enable"
        />
        <Button size="small" startIcon={<Colorize />} disabled={disabled} onClick={() => void pick()}>
          Pick viewer
        </Button>
      </Box>
      {pickerMessage ? <Alert severity="info" sx={{ mb: 1, py: 0 }}>{pickerMessage}</Alert> : null}
      <QualifierRangeBar
        label="Hue"
        background="linear-gradient(90deg, #06b6d4, #3b82f6, #a855f7, #ef4444, #eab308, #22c55e, #06b6d4)"
        disabled={controlsDisabled}
        periodic
        boundaries={hueBoundaries}
        readout={hueIsFullRange ? "All hues" : undefined}
        formatValue={(value) => `${Math.round(value * 360) % 360}°`}
        weightAt={(position) =>
          circularHueWeight(
            wrap(position - 0.5),
            parameters.hueCenter,
            parameters.hueWidth,
            parameters.hueSoftLo,
            parameters.hueSoftHi,
          )
        }
        onBoundaryChange={changeHue}
        onInteractionStart={beginInteraction}
        onInteractionCommit={commitInteraction}
        onRangeShift={(delta, commit) =>
          update({ hueCenter: wrap(parameters.hueCenter + delta) }, commit)
        }
      />
      <QualifierRangeBar
        label="Saturation"
        background="linear-gradient(90deg, #71717a, #ef4444)"
        disabled={controlsDisabled}
        boundaries={linearBoundaries(
          parameters.satLo,
          parameters.satHi,
          parameters.satSoftLo,
          parameters.satSoftHi,
        )}
        formatValue={(value) => `${Math.round(value * 100)}%`}
        weightAt={(value) =>
          softTrapezoidWeight(
            value,
            parameters.satLo,
            parameters.satHi,
            parameters.satSoftLo,
            parameters.satSoftHi,
          )
        }
        onBoundaryChange={(boundary, value, commit) =>
          changeLinear("sat", boundary, value, commit)
        }
        onInteractionStart={beginInteraction}
        onInteractionCommit={commitInteraction}
        onRangeShift={(delta, commit) =>
          shiftLinearRange("sat", delta, commit)
        }
      />
      <QualifierRangeBar
        label="Luma"
        background="linear-gradient(90deg, #000, #fff)"
        disabled={controlsDisabled}
        boundaries={linearBoundaries(
          parameters.lumaLo,
          parameters.lumaHi,
          parameters.lumaSoftLo,
          parameters.lumaSoftHi,
        )}
        formatValue={(value) => `${Math.round(value * 100)}%`}
        weightAt={(value) =>
          softTrapezoidWeight(
            value,
            parameters.lumaLo,
            parameters.lumaHi,
            parameters.lumaSoftLo,
            parameters.lumaSoftHi,
          )
        }
        onBoundaryChange={(boundary, value, commit) =>
          changeLinear("luma", boundary, value, commit)
        }
        onInteractionStart={beginInteraction}
        onInteractionCommit={commitInteraction}
        onRangeShift={(delta, commit) =>
          shiftLinearRange("luma", delta, commit)
        }
      />
      <Box sx={{ display: "flex", gap: 2 }}>
        <FormControlLabel
          control={<Switch size="small" checked={parameters.qualifierInvert} disabled={controlsDisabled} onChange={(_, checked) => update({ qualifierInvert: checked }, true)} />}
          label="Invert"
        />
        <FormControlLabel
          control={<Switch size="small" checked={parameters.mattePreview} disabled={controlsDisabled} onChange={(_, checked) => update({ mattePreview: checked }, true)} />}
          label="Matte"
        />
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        White areas receive this grade; black areas pass its input through.
      </Typography>
    </Box>
  );
}
