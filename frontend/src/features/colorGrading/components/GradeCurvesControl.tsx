import { useEffect, useRef, useState } from "react";
import { Box } from "@mui/material";
import {
  useLiveParameterPreviewSession,
  type CustomControlRenderProps,
} from "../../panelUI";
import type { ColorCurvePoint } from "../../../core/color";
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const histograms = useCurveHistograms(
    props.transformId ?? "unbound-grade",
    visible && Boolean(props.transformId),
  );
  const kind = props.control.config?.kind;
  const tabs = kind === "hue" ? HUE_TABS : VALUE_TABS;
  const {
    preview: previewParameters,
    commit: commitParameters,
  } = useLiveParameterPreviewSession({
    transformId: props.transformId,
    onCommitMany: props.onCommitMany,
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let intersecting = true;
    const update = (): void => {
      setVisible(
        intersecting &&
          (typeof document === "undefined" ||
            document.visibilityState !== "hidden"),
      );
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry?.isIntersecting ?? false;
            update();
          });
    observer?.observe(root);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <Box ref={rootRef}>
      <ValueCurveEditor
        tabs={tabs}
        values={props.values}
        beforeHistograms={histograms?.before}
        afterHistograms={histograms?.after}
        disabled={props.disabled}
        onPreview={(name, points) => {
          previewParameters({ [name]: points });
        }}
        onCommit={(name, points: readonly ColorCurvePoint[]) => {
          commitParameters({ [name]: points });
        }}
      />
    </Box>
  );
}
