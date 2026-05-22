import { useRef, useState, useMemo, useEffect, useCallback } from "react";
import { Box } from "@mui/material";
import { MonotoneCubicSpline, type SplinePoint } from "../../utils/MonotoneCubicSpline";
import type { SplineParameter } from "../../types";

interface SplineGraphProps {
  value: SplineParameter;
  onChange: (newValue: SplineParameter) => void;
  width: number;
  height: number;
  minTime?: number;  // Min Time (X axis start, layer input time)
  duration: number;  // Duration (X axis extent)
  minY?: number;     // Hard Min
  maxY?: number;     // Hard Max
  softMin?: number;  // Default View Min
  softMax?: number;  // Default View Max
  constrainMonotoneIncreasing?: boolean;
  lockEndpoints?: boolean;
  allowPointDeletion?: boolean;
}

function sanitizeInitialPoints(points: SplinePoint[]): SplinePoint[] {
  return [...points].sort((left, right) => left.time - right.time);
}

export function SplineGraph({
  value,
  onChange,
  width,
  height,
  minTime = 0,
  duration,
  minY = 0,
  maxY = 2,
  softMin,
  softMax,
  constrainMonotoneIncreasing = false,
  lockEndpoints = false,
  allowPointDeletion = true,
}: SplineGraphProps) {
  // Local state for smooth dragging
  const [localPoints, setLocalPoints] = useState<SplinePoint[]>(() =>
    sanitizeInitialPoints(value.points),
  );
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Viewport State
  const [viewMin, setViewMin] = useState(softMin ?? minY);
  const [viewMax, setViewMax] = useState(softMax ?? maxY);

  const sanitizePoints = useCallback((inputPoints: SplinePoint[]) => {
    let nextPoints = [...inputPoints].sort((left, right) => left.time - right.time);
    const endpointMaxTime = minTime + duration;

    if (lockEndpoints) {
      const startPoint = { time: minTime, value: minY };
      const endPoint = { time: endpointMaxTime, value: maxY };

      if (nextPoints.length === 0) {
        nextPoints = [startPoint, endPoint];
      } else {
        if (Math.abs((nextPoints[0]?.time ?? Infinity) - minTime) <= 0.0001) {
          nextPoints[0] = startPoint;
        } else {
          nextPoints.unshift(startPoint);
        }

        const lastIndex = nextPoints.length - 1;
        if (
          Math.abs((nextPoints[lastIndex]?.time ?? -Infinity) - endpointMaxTime) <=
          0.0001
        ) {
          nextPoints[lastIndex] = endPoint;
        } else {
          nextPoints.push(endPoint);
        }
      }
    }

    if (constrainMonotoneIncreasing && nextPoints.length > 1) {
      const monotonePoints = [...nextPoints];
      for (let index = 1; index < monotonePoints.length; index += 1) {
        monotonePoints[index] = {
          ...monotonePoints[index],
          value: Math.max(
            monotonePoints[index - 1].value,
            monotonePoints[index].value,
          ),
        };
      }
      nextPoints = monotonePoints;
    }

    return nextPoints;
  }, [constrainMonotoneIncreasing, duration, lockEndpoints, maxY, minTime, minY]);

  const commitPoints = useCallback((newPoints: SplinePoint[]) => {
      onChange({ ...value, points: sanitizePoints(newPoints) });
  }, [onChange, sanitizePoints, value]);

  // Refs for drag-state access inside pointer handlers and RAF callbacks.
  const stateRef = useRef({
    localPoints: sanitizeInitialPoints(value.points),
    viewMin: softMin ?? minY,
    viewMax: softMax ?? maxY,
  });
  const mouseRef = useRef<{ x: number, y: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
     stateRef.current.viewMin = viewMin;
     stateRef.current.viewMax = viewMax;
  }, [viewMin, viewMax]);

  const setLocalPointsState = useCallback((nextPoints: SplinePoint[]) => {
    stateRef.current.localPoints = nextPoints;
    setLocalPoints(nextPoints);
  }, []);

  useEffect(() => {
    if (dragIdx !== null) {
      return;
    }

    const nextPoints = sanitizePoints(value.points);
    setLocalPointsState(nextPoints);
  }, [dragIdx, sanitizePoints, setLocalPointsState, value.points]);

  useEffect(() => {
    if (dragIdx !== null) {
      return;
    }

    let targetMin = softMin ?? minY;
    let targetMax = softMax ?? maxY;

    for (const point of value.points) {
      if (point.value < targetMin) targetMin = point.value;
      if (point.value > targetMax) targetMax = point.value;
    }

    setViewMin(Math.max(minY, targetMin));
    setViewMax(Math.min(maxY, targetMax));
  }, [dragIdx, maxY, minY, softMax, softMin, value.points]);

  // 1. Coordinate Transform Helpers
  // X-axis domain is [minTime, minTime + duration] (layer input time)
  // Points are stored in source time, which maps to layer input time via upstream transforms
  const padding = 10;
  const graphWidth = width - padding * 2;
  const graphHeight = height - padding * 2;
  const maxTime = minTime + duration; // Used for clamping and rendering

  // Convert time (in layer input time) to X pixel
  const timeToX = useCallback((t: number) => padding + ((t - minTime) / duration) * graphWidth, [duration, graphWidth, padding, minTime]);
  // Convert Y value to pixel
  const valToY = useCallback((v: number) => height - padding - ((v - viewMin) / (viewMax - viewMin)) * graphHeight, [graphHeight, height, padding, viewMax, viewMin]);

  // Convert X pixel to time (in layer input time)
  const xToTime = useCallback((x: number) => minTime + ((x - padding) / graphWidth) * duration, [duration, graphWidth, padding, minTime]);
  // Convert Y pixel to value
  const yToVal = useCallback((y: number, vMin: number, vMax: number) => vMin + ((height - padding - y) / graphHeight) * (vMax - vMin), [graphHeight, height, padding]);

  // 2. Generate Screen Path (from local points)
  const pathD = useMemo(() => {
    const screenPoints = localPoints.map((p) => {
      return {
        time: padding + ((p.time - minTime) / duration) * graphWidth,
        value: height - padding - ((p.value - viewMin) / (viewMax - viewMin)) * graphHeight,
      };
    });
    const spline = new MonotoneCubicSpline(screenPoints);
    return spline.getSVGPath();
  }, [localPoints, duration, padding, graphWidth, height, viewMin, viewMax, graphHeight, minTime]); 

  const startDrag = useCallback(
    (index: number, initialMouse: { x: number; y: number }) => {
      dragCleanupRef.current?.();

      mouseRef.current = initialMouse;
      setDragIdx(index);

      let animationFrameId = 0;

      const onWindowMove = (event: MouseEvent) => {
        mouseRef.current = { x: event.clientX, y: event.clientY };
      };

      const cleanup = () => {
        window.removeEventListener("mousemove", onWindowMove);
        window.removeEventListener("mouseup", onWindowUp);
        cancelAnimationFrame(animationFrameId);
        if (dragCleanupRef.current === cleanup) {
          dragCleanupRef.current = null;
        }
      };

      const onWindowUp = () => {
        commitPoints(stateRef.current.localPoints);
        setDragIdx(null);
        cleanup();
      };

      const loop = () => {
        const mousePos = mouseRef.current;
        if (!svgRef.current || !mousePos) {
          animationFrameId = requestAnimationFrame(loop);
          return;
        }

        const {
          localPoints: currentPoints,
          viewMin: currentMin,
          viewMax: currentMax,
        } = stateRef.current;

        const rect = svgRef.current.getBoundingClientRect();
        const mouseY = mousePos.y - rect.top;
        const mouseX = mousePos.x - rect.left;

        let newT = xToTime(mouseX);
        let newV = yToVal(mouseY, currentMin, currentMax);

        let nextViewMax = currentMax;
        let nextViewMin = currentMin;

        const currentRange = currentMax - currentMin;
        const baseSpeed = Math.max(currentRange * 0.01, 0.05);

        if (mouseY < padding) {
          nextViewMax = Math.min(maxY, currentMax + baseSpeed);
        } else if (mouseY > height - padding) {
          nextViewMin = Math.max(minY, currentMin - baseSpeed);
        }

        if (nextViewMax !== currentMax || nextViewMin !== currentMin) {
          setViewMax(nextViewMax);
          setViewMin(nextViewMin);
          newV = yToVal(mouseY, nextViewMin, nextViewMax);
        }

        newT = Math.max(minTime, Math.min(maxTime, newT));
        newV = Math.max(minY, Math.min(maxY, newV));

        const points = [...currentPoints];
        const prev = points[index - 1];
        const next = points[index + 1];

        const prevT = prev ? prev.time : -Infinity;
        const nextT = next ? next.time : Infinity;
        const clampedT = Math.max(prevT + 0.01, Math.min(nextT - 0.01, newT));

        if (constrainMonotoneIncreasing) {
          const prevValue = prev ? prev.value : minY;
          const nextValue = next ? next.value : maxY;
          newV = Math.max(prevValue, Math.min(nextValue, newV));
        }

        if (
          points[index] &&
          (points[index].time !== clampedT || points[index].value !== newV)
        ) {
          points[index] = { time: clampedT, value: newV };
          setLocalPointsState(points);
        }

        animationFrameId = requestAnimationFrame(loop);
      };

      window.addEventListener("mousemove", onWindowMove);
      window.addEventListener("mouseup", onWindowUp);
      dragCleanupRef.current = cleanup;
      loop();
    },
    [
      commitPoints,
      constrainMonotoneIncreasing,
      duration,
      graphWidth,
      height,
      maxTime,
      maxY,
      minTime,
      minY,
      padding,
      setLocalPointsState,
      xToTime,
      yToVal,
    ],
  );

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  // 3. Handlers
  const handleMouseDown = (e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return; // Only drag on left-click
    if (lockEndpoints && (index === 0 || index === localPoints.length - 1)) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    startDrag(index, { x: e.clientX, y: e.clientY });
  };

  const handlePointContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!allowPointDeletion) return;
    if (lockEndpoints && (index === 0 || index === localPoints.length - 1)) {
      return;
    }
    const newPoints = [...localPoints];
    newPoints.splice(index, 1);
    const sanitized = sanitizePoints(newPoints);
    setLocalPointsState(sanitized);
    commitPoints(sanitized);
  };

  const handleBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const t = xToTime(e.clientX - rect.left);
    const v = yToVal(e.clientY - rect.top, viewMin, viewMax);

    // Clamp time
    const clampedT = Math.max(minTime, Math.min(maxTime, t));

    const newPoint = {
      time: clampedT,
      value: Math.max(minY, Math.min(maxY, v)),
    };

    // Sort by time
    const newPoints = sanitizePoints(
      [...localPoints, newPoint].sort((a, b) => a.time - b.time),
    );
    const newIndex = newPoints.findIndex(
      (point) =>
        Math.abs(point.time - newPoint.time) <= 0.0001 &&
        Math.abs(point.value - newPoint.value) <= 0.0001,
    );
    mouseRef.current = { x: e.clientX, y: e.clientY };
    setLocalPointsState(newPoints);
    if (newIndex >= 0) {
      startDrag(newIndex, { x: e.clientX, y: e.clientY });
    }
  };

  return (
    <Box 
        sx={{ border: '1px solid #333', borderRadius: 1, bgcolor: '#1e1e1e', overflow: 'hidden', userSelect: 'none' }}
        // No local onMouseUp/Leave needed for drag, handled by window listener
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        style={{ display: "block", cursor: "crosshair" }}
        // No local onMouseMove needed
        onMouseDown={handleBackgroundMouseDown}
      >
        {/* Helper Lines (Zero line if visible, Max Soft line?) */}
        {viewMin <= 0 && viewMax >= 0 && (
             <line 
                x1={padding} y1={valToY(0)} 
                x2={width-padding} y2={valToY(0)} 
                stroke="#444" strokeDasharray="4" 
             />
        )}

        <path
            d={pathD}
            fill="none"
            stroke="#4caf50"
            strokeWidth="2"
        />

        {localPoints.map((p, i) => {
            return (
            <g key={i}>
                <circle
                    cx={timeToX(p.time)}
                    cy={valToY(p.value)}
                    r={5}
                    fill={dragIdx === i ? "#fff" : "#4caf50"}
                    stroke="#fff"
                    strokeWidth={1}
                    style={{ cursor: 'pointer' }}
                    onMouseDown={(e) => handleMouseDown(e, i)}
                    onContextMenu={(e) => handlePointContextMenu(e, i)}
                />
                {dragIdx === i && (
                    <text
                        x={timeToX(p.time)}
                        y={valToY(p.value) - 15}
                        fill="white"
                        fontSize="12"
                        textAnchor="middle"
                        style={{ pointerEvents: "none", userSelect: "none", textShadow: "0px 1px 2px black" }}
                    >
                        {p.value.toFixed(2)}
                    </text>
                )}
            </g>
            );
        })}
      </svg>
    </Box>
  );
}
