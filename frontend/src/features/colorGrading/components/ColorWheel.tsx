import { useCallback, useEffect, useRef } from "react";
import { Box, Typography } from "@mui/material";
import { hsvToRgb } from "../../../core/color";
import {
  adjustmentToWheelPoint,
  wheelPointToAdjustment,
  type WheelAdjustment,
} from "../utils/wheelMath";

const CANVAS_SIZE = 112;
const CENTER = CANVAS_SIZE / 2;
const DISC_RADIUS = 43;
const RING_INNER_RADIUS = 47;
const RING_OUTER_RADIUS = 54;

interface ColorWheelProps {
  label: string;
  value: WheelAdjustment;
  maxChroma: number;
  maxMaster: number;
  disabled?: boolean;
  onPreview: (value: WheelAdjustment) => void;
  onCommit: (value: WheelAdjustment) => void;
}

function drawWheel(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(CANVAS_SIZE, CANVAS_SIZE);
  for (let y = 0; y < CANVAS_SIZE; y += 1) {
    for (let x = 0; x < CANVAS_SIZE; x += 1) {
      const dx = x + 0.5 - CENTER;
      const dy = y + 0.5 - CENTER;
      const distance = Math.hypot(dx, dy);
      const index = (y * CANVAS_SIZE + x) * 4;
      let rgb: readonly [number, number, number] | null = null;
      if (distance <= DISC_RADIUS) {
        const hue = ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1;
        rgb = hsvToRgb([hue, distance / DISC_RADIUS, 0.92]);
      } else if (distance >= RING_INNER_RADIUS && distance <= RING_OUTER_RADIUS) {
        const level = Math.max(0.12, Math.min(0.95, 0.5 - dy / (RING_OUTER_RADIUS * 2)));
        rgb = [level, level, level];
      }
      if (!rgb) continue;
      image.data[index] = Math.round(rgb[0] * 255);
      image.data[index + 1] = Math.round(rgb[1] * 255);
      image.data[index + 2] = Math.round(rgb[2] * 255);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

export function ColorWheel({
  label,
  value,
  maxChroma,
  maxMaster,
  disabled = false,
  onPreview,
  onCommit,
}: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragModeRef = useRef<"color" | "master" | null>(null);
  const pendingRef = useRef(value);

  useEffect(() => {
    if (canvasRef.current) drawWheel(canvasRef.current);
  }, []);

  useEffect(() => {
    pendingRef.current = value;
  }, [value]);

  const updateFromPointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const scaleX = CANVAS_SIZE / rect.width;
      const scaleY = CANVAS_SIZE / rect.height;
      const x = (event.clientX - rect.left) * scaleX - CENTER;
      const y = (event.clientY - rect.top) * scaleY - CENTER;
      const mode = dragModeRef.current;
      if (!mode) return;
      const next =
        mode === "master"
          ? {
              ...pendingRef.current,
              master:
                Math.max(-1, Math.min(1, -y / DISC_RADIUS)) *
                maxMaster *
                (event.shiftKey ? 0.2 : 1),
            }
          : {
              ...pendingRef.current,
              ...wheelPointToAdjustment(
                x,
                y,
                DISC_RADIUS,
                maxChroma,
                event.shiftKey,
              ),
            };
      pendingRef.current = next;
      onPreview(next);
    },
    [maxChroma, maxMaster, onPreview],
  );

  const marker = adjustmentToWheelPoint(value, DISC_RADIUS, maxChroma);
  const masterY = CENTER - (value.master / maxMaster) * DISC_RADIUS;

  return (
    <Box sx={{ minWidth: 112, textAlign: "center", opacity: disabled ? 0.5 : 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Box sx={{ position: "relative", width: CANVAS_SIZE, height: CANVAS_SIZE, mx: "auto" }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          aria-label={`${label} color wheel`}
          onPointerDown={(event) => {
            if (disabled) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left) * (CANVAS_SIZE / rect.width) - CENTER;
            const y = (event.clientY - rect.top) * (CANVAS_SIZE / rect.height) - CENTER;
            dragModeRef.current =
              Math.hypot(x, y) >= RING_INNER_RADIUS ? "master" : "color";
            event.currentTarget.setPointerCapture(event.pointerId);
            updateFromPointer(event);
          }}
          onPointerMove={(event) => updateFromPointer(event)}
          onPointerUp={(event) => {
            if (!dragModeRef.current) return;
            updateFromPointer(event);
            dragModeRef.current = null;
            onCommit(pendingRef.current);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={() => {
            if (disabled) return;
            const reset = { r: 0, g: 0, b: 0, master: 0 };
            pendingRef.current = reset;
            onPreview(reset);
            onCommit(reset);
          }}
          style={{ display: "block", width: CANVAS_SIZE, height: CANVAS_SIZE, cursor: disabled ? "default" : "crosshair" }}
        />
        <Box
          sx={{
            position: "absolute",
            left: CENTER + marker.x - 4,
            top: CENTER + marker.y - 4,
            width: 8,
            height: 8,
            borderRadius: "50%",
            border: "1px solid white",
            boxShadow: "0 0 2px #000",
            pointerEvents: "none",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            left: CENTER + RING_INNER_RADIUS - 2,
            top: masterY - 2,
            width: 5,
            height: 5,
            borderRadius: "50%",
            bgcolor: "white",
            boxShadow: "0 0 2px #000",
            pointerEvents: "none",
          }}
        />
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled", fontSize: "0.62rem" }}>
        R {value.r.toFixed(2)} · G {value.g.toFixed(2)} · B {value.b.toFixed(2)} · M {value.master.toFixed(2)}
      </Typography>
    </Box>
  );
}
