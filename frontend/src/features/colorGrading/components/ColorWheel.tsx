import { useCallback, useEffect, useRef } from "react";
import { Box, Slider, Typography } from "@mui/material";
import { hsvToRgb } from "../../../core/color";
import {
  adjustmentToWheelPoint,
  wheelPointToAdjustment,
  type WheelAdjustment,
} from "../utils/wheelMath";

const CANVAS_SIZE = 96;
const CENTER = CANVAS_SIZE / 2;
const DISC_RADIUS = 45;

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
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startValue: WheelAdjustment;
    fine: boolean;
  } | null>(null);
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
      const drag = dragRef.current;
      if (!drag) return;
      if (event.shiftKey !== drag.fine) {
        dragRef.current = {
          ...drag,
          startX: x,
          startY: y,
          startValue: pendingRef.current,
          fine: event.shiftKey,
        };
        return;
      }
      const next = drag.fine
        ? (() => {
            const delta = wheelPointToAdjustment(
              x - drag.startX,
              y - drag.startY,
              DISC_RADIUS,
              maxChroma,
              true,
            );
            return {
              ...pendingRef.current,
              r: drag.startValue.r + delta.r,
              g: drag.startValue.g + delta.g,
              b: drag.startValue.b + delta.b,
            };
          })()
        : {
            ...pendingRef.current,
            ...wheelPointToAdjustment(x, y, DISC_RADIUS, maxChroma),
          };
      pendingRef.current = next;
      onPreview(next);
    },
    [maxChroma, onPreview],
  );

  const marker = adjustmentToWheelPoint(value, DISC_RADIUS, maxChroma);

  const previewMaster = useCallback(
    (master: number) => {
      const next = { ...pendingRef.current, master };
      pendingRef.current = next;
      onPreview(next);
    },
    [onPreview],
  );

  const commitMaster = useCallback(
    (master: number) => {
      const next = { ...pendingRef.current, master };
      pendingRef.current = next;
      onCommit(next);
    },
    [onCommit],
  );

  return (
    <Box sx={{ minWidth: 124, textAlign: "center", opacity: disabled ? 0.5 : 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
        }}
      >
        <Box
          sx={{
            position: "relative",
            width: CANVAS_SIZE,
            height: CANVAS_SIZE,
          }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            aria-label={`${label} color wheel`}
            onPointerDown={(event) => {
              if (disabled) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const x =
                (event.clientX - rect.left) * (CANVAS_SIZE / rect.width) -
                CENTER;
              const y =
                (event.clientY - rect.top) * (CANVAS_SIZE / rect.height) -
                CENTER;
              dragRef.current = {
                startX: x,
                startY: y,
                startValue: pendingRef.current,
                fine: event.shiftKey,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              updateFromPointer(event);
            }}
            onPointerMove={(event) => updateFromPointer(event)}
            onPointerUp={(event) => {
              if (!dragRef.current) return;
              updateFromPointer(event);
              dragRef.current = null;
              onCommit(pendingRef.current);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onDoubleClick={() => {
              if (disabled) return;
              const reset = { ...pendingRef.current, r: 0, g: 0, b: 0 };
              pendingRef.current = reset;
              onPreview(reset);
              onCommit(reset);
            }}
            style={{
              display: "block",
              width: CANVAS_SIZE,
              height: CANVAS_SIZE,
              cursor: disabled ? "default" : "crosshair",
            }}
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
        </Box>
        <Box
          sx={{
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
          }}
        >
          <Slider
            orientation="vertical"
            min={-maxMaster}
            max={maxMaster}
            step={maxMaster / 100}
            value={value.master}
            disabled={disabled}
            aria-label={`${label} master`}
            onChange={(_, next) => previewMaster(next as number)}
            onChangeCommitted={(_, next) => commitMaster(next as number)}
            onDoubleClick={(event) => {
              if (disabled) return;
              event.stopPropagation();
              previewMaster(0);
              commitMaster(0);
            }}
            sx={{
              height: 72,
              color: "text.primary",
              "& .MuiSlider-rail": {
                opacity: 1,
                bgcolor: "divider",
                width: 4,
              },
              "& .MuiSlider-track": { width: 4 },
              "& .MuiSlider-thumb": {
                width: 16,
                height: 8,
                borderRadius: 0.75,
                border: "1px solid",
                borderColor: "background.paper",
                boxShadow: 1,
              },
            }}
          />
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", fontSize: "0.62rem", lineHeight: 1 }}
          >
            M
          </Typography>
        </Box>
      </Box>
      <Typography variant="caption" sx={{ color: "text.disabled", fontSize: "0.62rem" }}>
        R {value.r.toFixed(2)} · G {value.g.toFixed(2)} · B {value.b.toFixed(2)} · M {value.master.toFixed(2)}
      </Typography>
    </Box>
  );
}
