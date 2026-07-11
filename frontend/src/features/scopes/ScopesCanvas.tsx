import { useEffect, useRef } from "react";
import type { ScopeKind } from "./useScopesStore";
import type { ScopeSnapshot } from "./scopeAnalysis";
import { HISTOGRAM_BINS, SCOPE_HEIGHT, SCOPE_WIDTH } from "./scopeAnalysis";

interface ScopesCanvasProps {
  kind: ScopeKind;
  snapshot: ScopeSnapshot | null;
}

function drawDensity(
  context: CanvasRenderingContext2D,
  values: Float32Array,
  width: number,
  height: number,
  colors: readonly [number, number, number][],
): void {
  const image = context.createImageData(width, height);
  const channelWidth = width / colors.length;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value <= 0) continue;
    const x = index % width;
    const color = colors[Math.min(colors.length - 1, Math.floor(x / channelWidth))];
    image.data[index * 4] = color[0] * value;
    image.data[index * 4 + 1] = color[1] * value;
    image.data[index * 4 + 2] = color[2] * value;
    image.data[index * 4 + 3] = Math.min(255, 40 + value * 215);
  }
  context.putImageData(image, 0, 0);
}

export function ScopesCanvas({ kind, snapshot }: ScopesCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#030712";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!snapshot) return;

    if (kind === "waveform") {
      drawDensity(context, snapshot.waveform, SCOPE_WIDTH, SCOPE_HEIGHT, [[80, 255, 150]]);
    } else if (kind === "parade") {
      drawDensity(context, snapshot.parade, SCOPE_WIDTH * 3, SCOPE_HEIGHT, [
        [255, 70, 70],
        [70, 255, 120],
        [70, 130, 255],
      ]);
    } else if (kind === "vectorscope") {
      drawDensity(context, snapshot.vectorscope, SCOPE_WIDTH, SCOPE_WIDTH, [[120, 255, 170]]);
    } else {
      const colors = ["#ef4444", "#22c55e", "#3b82f6", "#f8fafc"];
      snapshot.histogram.forEach((values, channel) => {
        context.beginPath();
        context.strokeStyle = colors[channel];
        context.globalAlpha = channel === 3 ? 0.75 : 0.9;
        for (let index = 0; index < HISTOGRAM_BINS; index += 1) {
          const x = (index / (HISTOGRAM_BINS - 1)) * canvas.width;
          const y = canvas.height - values[index] * canvas.height;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      });
      context.globalAlpha = 1;
    }
  }, [kind, snapshot]);

  const width = kind === "parade" ? SCOPE_WIDTH * 3 : SCOPE_WIDTH;
  const height = kind === "vectorscope" ? SCOPE_WIDTH : SCOPE_HEIGHT;
  return <canvas ref={canvasRef} width={width} height={height} style={{ width: "100%", height: 220, display: "block" }} />;
}
