import { useMemo, useRef } from "react";
import { Box, Typography } from "@mui/material";
import { applyToneCurve } from "../../../core/color";
import {
  highlightRolloffStrength,
  shadowLiftStrength,
  type ToneGraphParameters,
  type ToneMacro,
} from "../utils/toneShaping";

const DOMAIN_MAX = 1.5;
const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 180;
const RESPONSE_SAMPLES = 192;
const HANDLE_MARGIN = 8;

interface ToneResponseGraphProps {
  parameters: ToneGraphParameters;
  disabled?: boolean;
  onPreview: (macro: ToneMacro, strength: number) => void;
  onCommit: (macro: ToneMacro, strength: number) => void;
}

interface DragState {
  macro: ToneMacro;
  strength: number;
  startStrength: number;
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

function strengthFromDrag(
  drag: DragState,
  clientX: number,
  clientY: number,
  bounds: DOMRect,
): number {
  if (drag.macro === "highlight") {
    const travel = Math.max(bounds.height * (0.2 / DOMAIN_MAX), 1);
    return clamp(
      drag.startStrength + (clientY - drag.startClientY) / travel,
      0,
      1,
    );
  }
  const travel = Math.max(bounds.width * (0.5 / DOMAIN_MAX), 1);
  return clamp(
    drag.startStrength + (clientX - drag.startClientX) / travel,
    0,
    1,
  );
}

function keyboardStrength(
  macro: ToneMacro,
  current: number,
  key: string,
): number | null {
  const increaseKey = macro === "highlight" ? "ArrowDown" : "ArrowRight";
  const decreaseKey = macro === "highlight" ? "ArrowUp" : "ArrowLeft";
  if (key === increaseKey) return clamp(current + 0.05, 0, 1);
  if (key === decreaseKey) return clamp(current - 0.05, 0, 1);
  if (key === "Home") return 0;
  if (key === "End") return 1;
  return null;
}

export function ToneResponseGraph({
  parameters,
  disabled = false,
  onPreview,
  onCommit,
}: ToneResponseGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const path = useMemo(() => responsePath(parameters), [parameters]);
  const highlight = highlightRolloffStrength(parameters);
  const shadow = shadowLiftStrength(parameters);
  const highlightX = inverseContrast(
    parameters.kneeThreshold + parameters.kneeSoftness,
    parameters.contrast,
    parameters.pivot,
  );
  const highlightY = parameters.kneeThreshold;
  const shadowX = inverseContrast(
    parameters.toeSoftness,
    parameters.contrast,
    parameters.pivot,
  );
  const shadowY = parameters.toeSoftness;

  const updatePointer = (
    event: React.PointerEvent<SVGCircleElement>,
  ): void => {
    const bounds = svgRef.current?.getBoundingClientRect();
    const drag = dragRef.current;
    if (!bounds || !drag) return;
    const strength = strengthFromDrag(
      drag,
      event.clientX,
      event.clientY,
      bounds,
    );
    dragRef.current = { ...drag, strength };
    onPreview(drag.macro, strength);
  };

  const handleKey = (
    macro: ToneMacro,
    current: number,
    event: React.KeyboardEvent<SVGCircleElement>,
  ): void => {
    const strength = keyboardStrength(macro, current, event.key);
    if (strength === null) return;
    event.preventDefault();
    onPreview(macro, strength);
    onCommit(macro, strength);
  };

  const handle = (
    macro: ToneMacro,
    strength: number,
    x: number,
    y: number,
    color: string,
    label: string,
  ) => (
    <circle
      cx={clamp(
        xPosition(clamp(x, 0, DOMAIN_MAX)),
        HANDLE_MARGIN,
        VIEW_WIDTH - HANDLE_MARGIN,
      )}
      cy={clamp(
        yPosition(clamp(y, 0, DOMAIN_MAX)),
        HANDLE_MARGIN,
        VIEW_HEIGHT - HANDLE_MARGIN,
      )}
      r="6"
      fill={color}
      stroke="white"
      strokeWidth="1.5"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(strength.toFixed(2))}
      aria-orientation={macro === "highlight" ? "vertical" : "horizontal"}
      style={{ cursor: disabled ? "default" : "grab", touchAction: "none" }}
      onKeyDown={(event) => {
        if (!disabled) handleKey(macro, strength, event);
      }}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          macro,
          strength,
          startStrength: strength,
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
        const finalStrength = dragRef.current?.strength ?? strength;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(macro, finalStrength);
      }}
    >
      <title>{label}</title>
    </circle>
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
            <text x="5" y={VIEW_HEIGHT - 5}>0</text>
            <text x={xPosition(1) - 7} y={VIEW_HEIGHT - 5}>1.0</text>
            <text x={VIEW_WIDTH - 19} y={VIEW_HEIGHT - 5}>1.5</text>
            <text x="5" y={yPosition(1) - 5}>1.0</text>
            <text x="5" y="11">1.5</text>
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
