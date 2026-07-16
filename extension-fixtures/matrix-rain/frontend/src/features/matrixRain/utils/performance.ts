import { calculateStateGridSize } from "./feedbackLifecycle";

export interface MatrixRainWorkloadInput {
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly verticalSpacing: number;
  readonly maxHistorySeconds?: number;
  readonly maxStepSeconds?: number;
}

export interface MatrixRainWorkloadEstimate {
  readonly fullResolutionPixels: number;
  readonly stateWidth: number;
  readonly stateHeight: number;
  readonly stateTexels: number;
  readonly stateToFullResolutionRatio: number;
  readonly pingPongStateBytes: number;
  readonly maximumWarmupSamples: number;
}

/** Static workload instrumentation; it performs no rendering or CPU cell loop. */
export function estimateMatrixRainWorkload(
  input: MatrixRainWorkloadInput,
): MatrixRainWorkloadEstimate {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(1, Math.floor(input.height));
  const grid = calculateStateGridSize(
    width,
    height,
    input.size,
    input.verticalSpacing,
  );
  const fullResolutionPixels = width * height;
  const stateTexels = grid.width * grid.height;
  const history = Math.max(0, input.maxHistorySeconds ?? 0);
  const step = Math.max(1e-6, input.maxStepSeconds ?? 1 / 30);
  return {
    fullResolutionPixels,
    stateWidth: grid.width,
    stateHeight: grid.height,
    stateTexels,
    stateToFullResolutionRatio: stateTexels / fullResolutionPixels,
    // Two persistent RGBA8 state textures.
    pingPongStateBytes: stateTexels * 4 * 2,
    maximumWarmupSamples: Math.ceil(history / step),
  };
}
