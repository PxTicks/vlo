import { useRef, useState } from "react";
import { Box, Typography } from "@mui/material";

export type QualifierBoundaryId =
  | "outerLow"
  | "innerLow"
  | "innerHigh"
  | "outerHigh";

export interface QualifierRangeBoundary {
  readonly id: QualifierBoundaryId;
  readonly position: number;
  readonly value: number;
}

interface QualifierRangeBarProps {
  label: string;
  background: string;
  boundaries: readonly QualifierRangeBoundary[];
  weightAt(position: number): number;
  formatValue(value: number): string;
  readout?: string;
  periodic?: boolean;
  disabled?: boolean;
  onInteractionStart(): void;
  onInteractionCommit(): void;
  onBoundaryChange(
    boundary: QualifierBoundaryId,
    position: number,
    commit: boolean,
  ): void;
  onRangeShift(delta: number, commit: boolean): void;
}

interface ActiveDrag {
  readonly kind: QualifierBoundaryId | "range";
  lastPosition: number;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isOuterBoundary(boundary: QualifierBoundaryId): boolean {
  return boundary === "outerLow" || boundary === "outerHigh";
}

function isLowBoundary(boundary: QualifierBoundaryId): boolean {
  return boundary === "outerLow" || boundary === "innerLow";
}

function boundaryWidth(boundary: QualifierBoundaryId): number {
  return isOuterBoundary(boundary) ? 3.6 : 2;
}

function boundaryPath(
  position: number,
  boundary: QualifierBoundaryId,
): string {
  const x = clampUnit(position) * 100;
  const width = boundaryWidth(boundary);
  if (isLowBoundary(boundary)) {
    // The boundary coordinate is the full-height inner (right) edge.
    return `M ${x} 7 L ${x} 22 L ${x - width} 22 L ${x - width} 11 Z`;
  }
  // Mirror the low handle: the full-height inner edge is now on the left.
  return `M ${x} 7 L ${x + width} 11 L ${x + width} 22 L ${x} 22 Z`;
}

const BOUNDARY_LABELS: Record<QualifierBoundaryId, string> = {
  outerLow: "outer low",
  innerLow: "inner low",
  innerHigh: "inner high",
  outerHigh: "outer high",
};

export function QualifierRangeBar({
  label,
  background,
  boundaries,
  weightAt,
  formatValue,
  readout,
  periodic,
  disabled,
  onInteractionStart,
  onInteractionCommit,
  onBoundaryChange,
  onRangeShift,
}: QualifierRangeBarProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const [active, setActive] = useState<ActiveDrag["kind"] | null>(null);
  const boundaryById = Object.fromEntries(
    boundaries.map((boundary) => [boundary.id, boundary]),
  ) as Record<QualifierBoundaryId, QualifierRangeBoundary>;
  const orderedBoundaries = [...boundaries].sort(
    (left, right) =>
      Number(isOuterBoundary(right.id)) - Number(isOuterBoundary(left.id)),
  );

  const pointerPosition = (clientX: number): number => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return 0;
    return clampUnit((clientX - bounds.left) / bounds.width);
  };

  const selectedSegments = (() => {
    const low = boundaryById.innerLow.position;
    const high = boundaryById.innerHigh.position;
    if (!periodic || low <= high) return [{ start: low, end: high }];
    return [
      { start: low, end: 1 },
      { start: 0, end: high },
    ];
  })();

  const beginDrag = (
    kind: ActiveDrag["kind"],
    event: React.PointerEvent<SVGElement>,
  ): void => {
    if (disabled) return;
    const position = pointerPosition(event.clientX);
    dragRef.current = { kind, lastPosition: position };
    setActive(kind);
    onInteractionStart();
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const applyDrag = (position: number, commit: boolean): void => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "range") {
      let delta = position - drag.lastPosition;
      if (periodic && Math.abs(delta) > 0.5) delta -= Math.sign(delta);
      onRangeShift(delta, commit);
      drag.lastPosition = position;
    } else {
      onBoundaryChange(drag.kind, position, commit);
    }
    drag.lastPosition = position;
  };

  const lowReadout = `${formatValue(boundaryById.outerLow.value)} / ${formatValue(
    boundaryById.innerLow.value,
  )}`;
  const highReadout = `${formatValue(
    boundaryById.innerHigh.value,
  )} \\ ${formatValue(boundaryById.outerHigh.value)}`;
  const weightPath = `${Array.from({ length: 51 }, (_, index) => {
    const position = index / 50;
    return `${index === 0 ? "M" : "L"} ${position * 100} ${
      17 - weightAt(position) * 7
    }`;
  }).join(" ")} L 100 17 L 0 17 Z`;

  return (
    <Box sx={{ mb: 1.25, opacity: disabled ? 0.45 : 1 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.25 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {label}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
        >
          {readout ?? (
            <>
              {lowReadout}&nbsp;&nbsp;&nbsp;{highReadout}
            </>
          )}
        </Typography>
      </Box>
      <svg
        ref={svgRef}
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        height="34"
        width="100%"
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          applyDrag(pointerPosition(event.clientX), false);
        }}
        onPointerUp={(event) => {
          if (!dragRef.current) return;
          const position = pointerPosition(event.clientX);
          if (position !== dragRef.current.lastPosition) {
            applyDrag(position, false);
          }
          onInteractionCommit();
          dragRef.current = null;
          setActive(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          if (dragRef.current) onInteractionCommit();
          dragRef.current = null;
          setActive(null);
        }}
        style={{ display: "block", touchAction: "none", overflow: "visible" }}
      >
        <foreignObject x="0" y="1" width="100" height="6">
          <div
            style={{
              width: "100%",
              height: "100%",
              background,
              borderRadius: 1,
            }}
          />
        </foreignObject>
        <rect x="0" y="10" width="100" height="7" fill="#52525b" />
        <path d={weightPath} fill="#d4d4d8" />
        {selectedSegments.map((segment) => (
          <rect
            key={`${segment.start}-${segment.end}`}
            x={segment.start * 100}
            y="8"
            width={(segment.end - segment.start) * 100}
            height="11"
            fill="transparent"
            role="slider"
            aria-label={`${label} selected range`}
            tabIndex={disabled ? -1 : 0}
            onPointerDown={(event) => beginDrag("range", event)}
            onKeyDown={(event) => {
              if (
                disabled ||
                (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
              ) {
                return;
              }
              onRangeShift(event.key === "ArrowLeft" ? -0.01 : 0.01, true);
              event.preventDefault();
            }}
            style={{ cursor: disabled ? "default" : "grab" }}
          />
        ))}
        {orderedBoundaries.map((boundary) => {
          const outer = isOuterBoundary(boundary.id);
          const low = isLowBoundary(boundary.id);
          const width = boundaryWidth(boundary.id);
          const x = boundary.position * 100;
          return (
            <g
              key={boundary.id}
              data-boundary={boundary.id}
              role="slider"
              aria-label={`${label} ${BOUNDARY_LABELS[boundary.id]}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={boundary.value}
              tabIndex={disabled ? -1 : 0}
              onPointerDown={(event) => beginDrag(boundary.id, event)}
              onKeyDown={(event) => {
                if (
                  disabled ||
                  (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                ) {
                  return;
                }
                const direction = event.key === "ArrowLeft" ? -1 : 1;
                onBoundaryChange(
                  boundary.id,
                  clampUnit(boundary.position + direction * 0.01),
                  true,
                );
                event.preventDefault();
              }}
              style={{ cursor: disabled ? "default" : "ew-resize" }}
            >
              <path
                d={boundaryPath(boundary.position, boundary.id)}
                fill={outer ? "#fafafa" : "#a1a1aa"}
                stroke={active === boundary.id ? "#60a5fa" : "#18181b"}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x={low ? x - width : x}
                y="7"
                width={width}
                height="15"
                fill="transparent"
              />
            </g>
          );
        })}
      </svg>
    </Box>
  );
}
