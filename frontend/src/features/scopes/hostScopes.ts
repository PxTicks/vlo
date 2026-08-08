import {
  analyzeScopePixels,
  HISTOGRAM_BINS,
  SCOPE_HEIGHT,
  SCOPE_WIDTH,
  type ScopeSnapshot,
} from "./scopeAnalysis";
import {
  hostScopeRegistry,
  type HostScopeRegistry,
  type ScopeFrameSample,
  type ScopeRenderTarget,
} from "./scopeRegistry";

const SCOPE_BACKGROUND = "#030712";

/**
 * One analysis per sampled frame, shared by the four native scopes. The
 * analyser produces all of them in a single pass, so keying the result on the
 * sample object keeps a tab switch — or a future side-by-side layout — from
 * paying for the walk again. A `WeakMap` bounds itself: an entry dies with the
 * sample the dock has already replaced.
 */
const frameAnalysis = new WeakMap<ScopeFrameSample, ScopeSnapshot>();

export function analyzeScopeFrame(frame: ScopeFrameSample): ScopeSnapshot {
  const cached = frameAnalysis.get(frame);
  if (cached) return cached;
  const snapshot = analyzeScopePixels(
    frame.pixels,
    frame.width,
    frame.height,
    frame.sampledAt,
  );
  frameAnalysis.set(frame, snapshot);
  return snapshot;
}

function drawDensity(
  context: CanvasRenderingContext2D,
  values: Float32Array,
  width: number,
  height: number,
  colors: readonly (readonly [number, number, number])[],
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

function drawHistogram(target: ScopeRenderTarget, snapshot: ScopeSnapshot): void {
  const { context, width, height } = target;
  const colors = ["#ef4444", "#22c55e", "#3b82f6", "#f8fafc"];
  snapshot.histogram.forEach((values, channel) => {
    context.beginPath();
    context.strokeStyle = colors[channel];
    context.globalAlpha = channel === 3 ? 0.75 : 0.9;
    for (let index = 0; index < HISTOGRAM_BINS; index += 1) {
      const x = (index / (HISTOGRAM_BINS - 1)) * width;
      const y = height - values[index] * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  });
  context.globalAlpha = 1;
}

/** Fills the host-owned surface before a scope draws into it. */
export function clearScopeSurface(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.fillStyle = SCOPE_BACKGROUND;
  context.fillRect(0, 0, width, height);
}

/**
 * Registers the built-in scopes. They go through the same registry a contributed
 * scope uses, so the dock has one presentation path rather than a native switch
 * plus an extension branch.
 */
export function registerHostScopes(
  registry: HostScopeRegistry = hostScopeRegistry,
): { dispose(): void } {
  const registrations = [
    registry.registerHostScope({
      id: "host.waveform",
      label: "Waveform",
      width: SCOPE_WIDTH,
      height: SCOPE_HEIGHT,
      order: 10,
      render: (target) =>
        drawDensity(
          target.context,
          analyzeScopeFrame(target.frame).waveform,
          target.width,
          target.height,
          [[80, 255, 150]],
        ),
    }),
    registry.registerHostScope({
      id: "host.parade",
      label: "Parade",
      width: SCOPE_WIDTH * 3,
      height: SCOPE_HEIGHT,
      order: 20,
      render: (target) =>
        drawDensity(
          target.context,
          analyzeScopeFrame(target.frame).parade,
          target.width,
          target.height,
          [
            [255, 70, 70],
            [70, 255, 120],
            [70, 130, 255],
          ],
        ),
    }),
    registry.registerHostScope({
      id: "host.vectorscope",
      label: "Vector",
      width: SCOPE_WIDTH,
      height: SCOPE_WIDTH,
      order: 30,
      render: (target) =>
        drawDensity(
          target.context,
          analyzeScopeFrame(target.frame).vectorscope,
          target.width,
          target.height,
          [[120, 255, 170]],
        ),
    }),
    registry.registerHostScope({
      id: "host.histogram",
      label: "Histogram",
      width: SCOPE_WIDTH,
      height: SCOPE_HEIGHT,
      order: 40,
      render: (target) => drawHistogram(target, analyzeScopeFrame(target.frame)),
    }),
  ];

  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose();
    },
  };
}
