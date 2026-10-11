import { useMemo, useRef } from "react";
import { Box, Typography } from "@mui/material";
import { applyToneCurve } from "../../../core/color";
import {
  effectiveKneeThreshold,
  effectiveToeSoftness,
  toneMacroPosition,
  toneMacroRange,
  toneMacroStrength,
  toneMacroUpdate,
  TONE_MACRO_SPAN,
  type ToneGraphParameters,
  type ToneMacro,
  type ToneParameters,
} from "../utils/toneShaping";

const DOMAIN_MAX = 1.5;
const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 180;
const RESPONSE_SAMPLES = 192;
const HANDLE_RADIUS = 6;
// Larger than the dot so the clipped quarter at a corner is still easy to grab.
const HANDLE_HIT_RADIUS = 12;
const HANDLE_FOCUS_RADIUS = 9;

interface ToneResponseGraphProps {
  parameters: ToneGraphParameters;
  disabled?: boolean;
  onPreview: (update: Partial<ToneParameters>) => void;
  onCommit: (update: Partial<ToneParameters>) => void;
  /** Ends a gesture that changed nothing; restores its starting values. */
  onCancel: (start: ToneParameters) => void;
}

interface DragState {
  macro: ToneMacro;
  start: ToneParameters;
  startPosition: number;
  position: number;
  update: Partial<ToneParameters>;
  startClientX: number;
  startClientY: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function xPosition(value: number): number {
  return (value / DOMAIN_MAX) * VIEW_WIDTH;
}

function yPosition(value: number): number {
  return (1 - value / DOMAIN_MAX) * VIEW_HEIGHT;
}

function inverseContrast(
  value: number,
  contrast: number,
  pivot: number,
): number {
  if (Math.abs(contrast) <= 1e-6) return pivot;
  return (value - pivot) / contrast + pivot;
}

function responsePath(parameters: ToneGraphParameters): string {
  return Array.from({ length: RESPONSE_SAMPLES }, (_, index) => {
    const input = (index / (RESPONSE_SAMPLES - 1)) * DOMAIN_MAX;
    const output = applyToneCurve([input, input, input], parameters)[0];
    return `${index === 0 ? "M" : "L"} ${xPosition(input)} ${yPosition(
      clamp(output, 0, DOMAIN_MAX),
    )}`;
  }).join(" ");
}

function positionFromDrag(
  drag: DragState,
  clientX: number,
  clientY: number,
  bounds: DOMRect,
): number {
  // Travel matches the handle's on-screen movement, so it tracks the pointer.
  const { min, max } = toneMacroRange(drag.macro, drag.start);
  const span = TONE_MACRO_SPAN[drag.macro] / DOMAIN_MAX;
  const delta =
    drag.macro === "highlight"
      ? (clientY - drag.startClientY) / Math.max(bounds.height * span, 1)
      : (clientX - drag.startClientX) / Math.max(bounds.width * span, 1);
  return clamp(drag.startPosition + delta, min, max);
}

function keyboardPosition(
  macro: ToneMacro,
  parameters: ToneParameters,
  key: string,
): number | null {
  const current = toneMacroPosition(macro, parameters);
  const { min, max } = toneMacroRange(macro, parameters);
  const increaseKey = macro === "highlight" ? "ArrowDown" : "ArrowRight";
  const decreaseKey = macro === "highlight" ? "ArrowUp" : "ArrowLeft";
  if (key === increaseKey) return clamp(current + 0.05, min, max);
  if (key === decreaseKey) return clamp(current - 0.05, min, max);
  if (key === "Home") return 0;
  if (key === "End") return 1;
  return null;
}

export function ToneResponseGraph({
  parameters,
  disabled = false,
  onPreview,
  onCommit,
  onCancel,
}: ToneResponseGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const path = useMemo(() => responsePath(parameters), [parameters]);
  const highlight = toneMacroStrength("highlight", parameters);
  const shadow = toneMacroStrength("shadow", parameters);
  const kneeThreshold = effectiveKneeThreshold(parameters);
  const highlightX = inverseContrast(
    kneeThreshold + parameters.kneeSoftness,
    parameters.contrast,
    parameters.pivot,
  );
  const highlightY = kneeThreshold;
  const toeSoftness = effectiveToeSoftness(parameters);
  const shadowX = inverseContrast(
    toeSoftness,
    parameters.contrast,
    parameters.pivot,
  );
  const shadowY = toeSoftness;

  const updatePointer = (event: React.PointerEvent<SVGGElement>): void => {
    const bounds = svgRef.current?.getBoundingClientRect();
    const drag = dragRef.current;
    if (!bounds || !drag) return;
    const position = positionFromDrag(
      drag,
      event.clientX,
      event.clientY,
      bounds,
    );
    const update = toneMacroUpdate(drag.macro, position, drag.start);
    dragRef.current = { ...drag, position, update };
    onPreview(update);
  };

  const handleKey = (
    macro: ToneMacro,
    event: React.KeyboardEvent<SVGGElement>,
  ): void => {
    const position = keyboardPosition(macro, parameters, event.key);
    if (position === null) return;
    event.preventDefault();
    // A no-op key (e.g. Home when inactive) must not write equal values, which
    // would still insert keyframes into an animated grade.
    if (position === toneMacroPosition(macro, parameters)) return;
    const update = toneMacroUpdate(macro, position, parameters);
    onPreview(update);
    onCommit(update);
  };

  const handle = (
    macro: ToneMacro,
    strength: number,
    x: number,
    y: number,
    color: string,
    label: string,
  ) => (
    // Centred on its true curve point even at the domain extremes, where the
    // graph clips it to a half or quarter circle rather than nudging it off
    // the curve.
    <g
      transform={`translate(${xPosition(clamp(x, 0, DOMAIN_MAX))} ${yPosition(
        clamp(y, 0, DOMAIN_MAX),
      )})`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(strength.toFixed(2))}
      aria-orientation={macro === "highlight" ? "vertical" : "horizontal"}
      style={{ cursor: disabled ? "default" : "grab", touchAction: "none" }}
      onKeyDown={(event) => {
        if (!disabled) handleKey(macro, event);
      }}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          macro,
          start: parameters,
          startPosition: toneMacroPosition(macro, parameters),
          position: toneMacroPosition(macro, parameters),
          update: {},
          startClientX: event.clientX,
          startClientY: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        if (disabled || dragRef.current?.macro !== macro) return;
        updatePointer(event);
      }}
      onPointerUp={(event) => {
        if (disabled || dragRef.current?.macro !== macro) return;
        updatePointer(event);
        const drag = dragRef.current;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (!drag) return;
        // A click, or a drag released where it began, commits nothing: equal
        // values would still insert keyframes into an animated grade.
        if (drag.position === drag.startPosition) {
          onCancel(drag.start);
          return;
        }
        onCommit(drag.update);
      }}
    >
      <title>{label}</title>
      <circle r={HANDLE_HIT_RADIUS} fill="transparent" />
      <circle
        className="tone-handle-focus"
        r={HANDLE_FOCUS_RADIUS}
        fill="none"
        stroke="white"
        strokeWidth="1.5"
        pointerEvents="none"
      />
      <circle r={HANDLE_RADIUS} fill={color} stroke="white" strokeWidth="1.5" />
    </g>
  );

  return (
    <Box>
      <Box
        sx={{
          height: 180,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          overflow: "hidden",
          background: "linear-gradient(135deg, #080b12, #202938)",
          opacity: disabled ? 0.5 : 1,
          // The browser's rectangular outline boxes the round handle; show a
          // ring for keyboard focus only.
          "& [role='slider']": { outline: "none" },
          "& .tone-handle-focus": { visibility: "hidden" },
          "& [role='slider']:focus-visible .tone-handle-focus": {
            visibility: "visible",
          },
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          aria-label="Tone response graph"
        >
          <rect
            x={xPosition(1)}
            y="0"
            width={VIEW_WIDTH - xPosition(1)}
            height={VIEW_HEIGHT}
            fill="rgba(245,158,11,0.08)"
          />
          <g stroke="rgba(255,255,255,0.12)" strokeWidth="0.7">
            <path d={`M ${xPosition(0.5)} 0 V ${VIEW_HEIGHT}`} />
            <path d={`M ${xPosition(1)} 0 V ${VIEW_HEIGHT}`} />
            <path d={`M 0 ${yPosition(0.5)} H ${VIEW_WIDTH}`} />
            <path d={`M 0 ${yPosition(1)} H ${VIEW_WIDTH}`} />
          </g>
          <path
            d={`M 0 ${yPosition(0)} L ${xPosition(DOMAIN_MAX)} ${yPosition(
              DOMAIN_MAX,
            )}`}
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <path d={path} fill="none" stroke="#f8fafc" strokeWidth="2" />
          <g fill="rgba(255,255,255,0.48)" fontSize="9" pointerEvents="none">
            <text x="5" y={VIEW_HEIGHT - 5}>
              0
            </text>
            <text x={xPosition(1) - 7} y={VIEW_HEIGHT - 5}>
              1.0
            </text>
            <text x={VIEW_WIDTH - 19} y={VIEW_HEIGHT - 5}>
              1.5
            </text>
            <text x="5" y={yPosition(1) - 5}>
              1.0
            </text>
            <text x="5" y="11">
              1.5
            </text>
          </g>
          <text x="6" y="25" fill="rgba(255,255,255,0.6)" fontSize="9">
            TONE STAGE
          </text>
          <text x={xPosition(1) + 5} y="14" fill="#f59e0b" fontSize="10">
            SUPER-WHITE
          </text>
          {handle(
            "highlight",
            highlight,
            highlightX,
            highlightY,
            "#f59e0b",
            "Highlight rolloff handle",
          )}
          {handle(
            "shadow",
            shadow,
            shadowX,
            shadowY,
            "#60a5fa",
            "Shadow lift handle",
          )}
        </svg>
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled", px: 1 }}>
        Pull amber down for highlight rolloff · pull blue right for shadow lift
      </Typography>
    </Box>
  );
}
