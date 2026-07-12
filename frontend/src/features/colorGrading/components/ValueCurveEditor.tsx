import { useCallback, useMemo, useRef, useState } from "react";
import { Box, Button, ButtonGroup, Typography } from "@mui/material";
import {
  DEFAULT_COLOR_CURVES,
  type ColorCurveParameterName,
  type ColorCurvePoint,
} from "../../../core/color";
import {
  clampCurvePointX,
  createCurveEvaluator,
  curvePointFromClient,
  sanitizeCurvePoints,
} from "../utils/curveMath";
import {
  curveHistogramAreaPath,
  curveHistogramLinePath,
  type CurveHistogramKind,
  type CurveHistograms,
} from "../utils/curveHistogram";
import {
  createHueHueFieldBackground,
  createHueSaturationFieldBackground,
  createLumaSaturationFieldBackground,
} from "../utils/curveResponseField";

export interface CurveEditorTab {
  readonly name: ColorCurveParameterName;
  readonly label: string;
  readonly color: string;
  readonly periodic: boolean;
  readonly yMin: number;
  readonly yMax: number;
  readonly background: string;
  readonly backgroundKind?:
    | "hue-result"
    | "hue-saturation-result"
    | "luma-saturation-result";
  readonly histogram: CurveHistogramKind;
}

interface ValueCurveEditorProps {
  tabs: readonly CurveEditorTab[];
  values: Readonly<Record<string, unknown>>;
  beforeHistograms?: CurveHistograms;
  afterHistograms?: CurveHistograms;
  disabled?: boolean;
  onPreview: (
    name: ColorCurveParameterName,
    points: readonly ColorCurvePoint[],
  ) => void;
  onCommit: (
    name: ColorCurveParameterName,
    points: readonly ColorCurvePoint[],
  ) => void;
}

function readPoints(
  value: unknown,
  fallback: readonly ColorCurvePoint[],
): ColorCurvePoint[] {
  if (!Array.isArray(value)) return [...fallback];
  const points = value.filter(
    (point): point is ColorCurvePoint =>
      typeof point === "object" &&
      point !== null &&
      "x" in point &&
      "y" in point &&
      typeof point.x === "number" &&
      typeof point.y === "number",
  );
  return points.length > 0 ? points.map((point) => ({ ...point })) : [...fallback];
}

export function ValueCurveEditor({
  tabs,
  values,
  beforeHistograms,
  afterHistograms,
  disabled = false,
  onPreview,
  onCommit,
}: ValueCurveEditorProps) {
  const [activeName, setActiveName] = useState(tabs[0].name);
  const [draft, setDraft] = useState<ColorCurvePoint[] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const pendingRef = useRef<ColorCurvePoint[]>([]);
  const activeTab = tabs.find((tab) => tab.name === activeName) ?? tabs[0];
  const committedPoints = useMemo(
    () =>
      sanitizeCurvePoints(
        readPoints(values[activeTab.name], DEFAULT_COLOR_CURVES[activeTab.name]),
        activeTab.yMin,
        activeTab.yMax,
      ),
    [activeTab, values],
  );
  const points = draft ?? committedPoints;

  const curveEvaluator = useMemo(
    () => createCurveEvaluator(points, activeTab.periodic),
    [activeTab.periodic, points],
  );
  const path = useMemo(() => {
    const samples = 128;
    return Array.from({ length: samples }, (_, index) => {
      const x = index / (samples - 1);
      const y = curveEvaluator.at(x);
      const normalizedY = (y - activeTab.yMin) / (activeTab.yMax - activeTab.yMin);
      return `${index === 0 ? "M" : "L"} ${x * 100} ${(1 - normalizedY) * 100}`;
    }).join(" ");
  }, [activeTab, curveEvaluator]);
  const beforeHistogramPath = useMemo(
    () =>
      curveHistogramAreaPath(
        beforeHistograms?.[activeTab.histogram] ?? new Float32Array(),
      ),
    [activeTab.histogram, beforeHistograms],
  );
  const afterHistogramPath = useMemo(
    () =>
      curveHistogramLinePath(
        afterHistograms?.[activeTab.histogram] ?? new Float32Array(),
      ),
    [activeTab.histogram, afterHistograms],
  );
  const editorBackground = useMemo(
    () =>
      activeTab.backgroundKind === "hue-result"
        ? createHueHueFieldBackground(activeTab.yMin, activeTab.yMax)
        : activeTab.backgroundKind === "hue-saturation-result"
          ? createHueSaturationFieldBackground(activeTab.yMin, activeTab.yMax)
          : activeTab.backgroundKind === "luma-saturation-result"
            ? createLumaSaturationFieldBackground(activeTab.yMin, activeTab.yMax)
            : activeTab.background,
    [activeTab],
  );

  const previewPoints = useCallback(
    (nextPoints: ColorCurvePoint[]) => {
      const sanitized = sanitizeCurvePoints(
        nextPoints,
        activeTab.yMin,
        activeTab.yMax,
      );
      pendingRef.current = sanitized;
      setDraft(sanitized);
      onPreview(activeTab.name, sanitized);
    },
    [activeTab, onPreview],
  );

  const locatePoint = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return curvePointFromClient(
        event.clientX,
        event.clientY,
        rect,
        activeTab.yMin,
        activeTab.yMax,
      );
    },
    [activeTab],
  );

  return (
    <Box>
      <ButtonGroup size="small" fullWidth sx={{ mb: 1 }}>
        {tabs.map((tab) => (
          <Button
            key={tab.name}
            variant={tab.name === activeTab.name ? "contained" : "outlined"}
            onClick={() => {
              setActiveName(tab.name);
              setDraft(null);
              dragIndexRef.current = null;
            }}
            sx={{ minWidth: 0, color: tab.name === activeTab.name ? undefined : tab.color }}
          >
            {tab.label}
          </Button>
        ))}
      </ButtonGroup>
      <Box
        sx={{
          position: "relative",
          height: 180,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          overflow: "hidden",
          background: editorBackground,
          backgroundSize: "100% 100%",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <svg
          ref={svgRef}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-label={`${activeTab.label} curve editor`}
          onPointerDown={(event) => {
            if (disabled) return;
            const nextPoint = locatePoint(event);
            const rect = event.currentTarget.getBoundingClientRect();
            const thresholdX = 10 / rect.width;
            const thresholdY =
              (10 / rect.height) * (activeTab.yMax - activeTab.yMin);
            let index = points.findIndex(
              (point) =>
                Math.abs(point.x - nextPoint.x) <= thresholdX &&
                Math.abs(point.y - nextPoint.y) <= thresholdY,
            );
            const nextPoints = points.map((point) => ({ ...point }));
            const addedPoint = index === -1;
            if (index === -1) {
              nextPoints.push(nextPoint);
              nextPoints.sort((left, right) => left.x - right.x);
              index = nextPoints.findIndex((point) => point === nextPoint);
            }
            dragIndexRef.current = index;
            if (addedPoint) {
              previewPoints(nextPoints);
            } else {
              pendingRef.current = nextPoints;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const dragIndex = dragIndexRef.current;
            if (dragIndex === null) return;
            const nextPoint = locatePoint(event);
            const nextPoints = pendingRef.current.map((point) => ({ ...point }));
            nextPoints[dragIndex] = {
              x: clampCurvePointX(nextPoints, dragIndex, nextPoint.x),
              y: nextPoint.y,
            };
            previewPoints(nextPoints);
          }}
          onPointerUp={(event) => {
            if (dragIndexRef.current === null) return;
            onCommit(activeTab.name, pendingRef.current);
            setDraft(null);
            dragIndexRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={() => {
            if (disabled) return;
            const reset = [...DEFAULT_COLOR_CURVES[activeTab.name]];
            onPreview(activeTab.name, reset);
            onCommit(activeTab.name, reset);
            setDraft(null);
          }}
          style={{ width: "100%", height: "100%", cursor: disabled ? "default" : "crosshair" }}
        >
          {beforeHistogramPath ? (
            <path
              d={beforeHistogramPath}
              fill={activeTab.color}
              fillOpacity="0.16"
              stroke={activeTab.color}
              strokeOpacity="0.28"
              strokeWidth="0.35"
              pointerEvents="none"
              aria-label={`${activeTab.label} histogram`}
            />
          ) : null}
          {afterHistogramPath ? (
            <path
              d={afterHistogramPath}
              fill="none"
              stroke={activeTab.color}
              strokeOpacity="0.72"
              strokeWidth="0.7"
              strokeDasharray="1.5 1"
              pointerEvents="none"
              aria-label={`${activeTab.label} after histogram`}
            />
          ) : null}
          <g stroke="rgba(255,255,255,0.15)" strokeWidth="0.35">
            <path d="M 25 0 V 100 M 50 0 V 100 M 75 0 V 100" />
            <path d="M 0 25 H 100 M 0 50 H 100 M 0 75 H 100" />
          </g>
          {activeTab.backgroundKind ? (
            <path
              d="M 0 50 H 100"
              stroke="rgba(255,255,255,0.38)"
              strokeWidth="0.55"
              pointerEvents="none"
              aria-label="Zero curve adjustment"
            />
          ) : null}
          <path d={path} fill="none" stroke={activeTab.color} strokeWidth="1.5" />
          {points.map((point, index) => {
            const normalizedY =
              (point.y - activeTab.yMin) / (activeTab.yMax - activeTab.yMin);
            return (
              <circle
                key={`${point.x}:${point.y}:${index}`}
                cx={point.x * 100}
                cy={(1 - normalizedY) * 100}
                r="2.2"
                fill={activeTab.color}
                stroke="white"
                strokeWidth="0.6"
                onContextMenu={(event) => {
                  event.preventDefault();
                  const minimum = 2;
                  if (disabled || points.length <= minimum) return;
                  const next = points.filter((_, pointIndex) => pointIndex !== index);
                  onPreview(activeTab.name, next);
                  onCommit(activeTab.name, next);
                }}
              />
            );
          })}
        </svg>
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        {activeTab.backgroundKind === "hue-result"
          ? "Field: resulting hue · centre: zero offset · filled: input · dashed: after"
          : activeTab.backgroundKind === "hue-saturation-result"
            ? "Field: relative resulting saturation by input hue · centre: unchanged"
            : activeTab.backgroundKind === "luma-saturation-result"
              ? "Field: relative saturation at reference blue by input luma · centre: unchanged"
              : "Filled: curve input · dashed: after curves · updates during playback while visible"}
      </Typography>
    </Box>
  );
}
