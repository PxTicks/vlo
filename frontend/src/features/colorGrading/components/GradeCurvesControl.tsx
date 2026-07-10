import { useEffect } from "react";
import type { CustomControlRenderProps } from "../../panelUI";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";
import type { ColorCurveParameterName, ColorCurvePoint } from "../../../core/color";
import { useCurveHistograms } from "../hooks/useCurveHistograms";
import { ValueCurveEditor, type CurveEditorTab } from "./ValueCurveEditor";

const VALUE_TABS: readonly CurveEditorTab[] = [
  {
    name: "curveMaster",
    label: "Y",
    color: "#fff",
    periodic: false,
    yMin: 0,
    yMax: 1,
    background: "linear-gradient(135deg, #09090b, #52525b)",
    histogram: "luma",
  },
  {
    name: "curveR",
    label: "R",
    color: "#ef4444",
    periodic: false,
    yMin: 0,
    yMax: 1,
    background: "linear-gradient(135deg, #09090b, #451a1a)",
    histogram: "red",
  },
  {
    name: "curveG",
    label: "G",
    color: "#22c55e",
    periodic: false,
    yMin: 0,
    yMax: 1,
    background: "linear-gradient(135deg, #09090b, #14532d)",
    histogram: "green",
  },
  {
    name: "curveB",
    label: "B",
    color: "#3b82f6",
    periodic: false,
    yMin: 0,
    yMax: 1,
    background: "linear-gradient(135deg, #09090b, #172554)",
    histogram: "blue",
  },
];

const HUE_TABS: readonly CurveEditorTab[] = [
  {
    name: "curveHueHue",
    label: "H→H",
    color: "#f8fafc",
    periodic: true,
    yMin: -0.5,
    yMax: 0.5,
    background:
      "linear-gradient(90deg, #ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)",
    histogram: "hue",
  },
  {
    name: "curveHueSat",
    label: "H→S",
    color: "#f8fafc",
    periodic: true,
    yMin: -0.5,
    yMax: 0.5,
    background:
      "linear-gradient(90deg, #7f1d1d, #713f12, #14532d, #164e63, #1e3a8a, #581c87, #7f1d1d)",
    histogram: "hue",
  },
  {
    name: "curveLumaSat",
    label: "L→S",
    color: "#f8fafc",
    periodic: false,
    yMin: -0.5,
    yMax: 0.5,
    background: "linear-gradient(90deg, #000, #fff)",
    histogram: "luma",
  },
];

export function GradeCurvesControl(props: CustomControlRenderProps) {
  const histograms = useCurveHistograms();
  const kind = props.control.config?.kind;
  const tabs = kind === "hue" ? HUE_TABS : VALUE_TABS;

  useEffect(() => {
    if (!props.transformId) return;
    const transformId = props.transformId;
    return () => {
      livePreviewParamStore.clearMany(
        tabs.map((tab) => ({ transformId, paramName: tab.name })),
      );
    };
  }, [props.transformId, tabs]);

  const clearPreview = (name: ColorCurveParameterName): void => {
    if (props.transformId) {
      livePreviewParamStore.clear(props.transformId, name);
    }
  };

  return (
    <ValueCurveEditor
      tabs={tabs}
      values={props.values}
      histograms={histograms ?? undefined}
      disabled={props.disabled}
      onPreview={(name, points) => {
        if (props.transformId) {
          livePreviewParamStore.set(props.transformId, name, points);
        }
      }}
      onCommit={(name, points: readonly ColorCurvePoint[]) => {
        props.onCommitMany({ [name]: points });
        clearPreview(name);
      }}
    />
  );
}
