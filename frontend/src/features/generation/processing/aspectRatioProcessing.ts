/**
 * Frontend port of the backend aspect-ratio processing math
 * (`backend/services/gen_pipeline/processors/utils/aspect_ratio_processing.py`).
 *
 * The backend applies these dimensions by hijacking resize-node params inside
 * the ComfyUI workflow; the frontend counterpart instead resizes the media
 * itself before dispatch and restores the true dimensions in postprocess, so
 * `applied_nodes` stays empty here. Both implementations must agree on the
 * numbers — parity is enforced by shared fixtures under
 * `shared/fixtures/generation-processing/` (run against both test suites).
 */

import type {
  AspectRatioProcessingMetadata,
  AspectRatioProcessingPostprocess,
} from "../types";

export interface ProcessingWarning {
  code: string;
  message: string;
  node_id?: string;
  details?: Record<string, unknown>;
}

export interface StridedDimensionsCandidate {
  width: number;
  height: number;
  aspect_ratio: number;
  distortion: number;
  error: number;
  area_delta: number;
  pixel_delta: number;
  stride: number;
  search_steps: number;
}

/**
 * Python's built-in round(): half-to-even ("banker's rounding"), unlike
 * Math.round's half-up. The strided search and short-edge derivation are
 * sensitive to exact-.5 ties (e.g. 1288 / 16 = 80.5), so parity with the
 * backend requires matching this.
 */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Backend `_to_positive_int`: accepts positive integers and digit-only
 * strings; rejects floats, booleans, and anything else.
 */
export function toStrictPositiveInteger(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    return value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const stripped = value.trim();
    if (/^\d+$/.test(stripped)) {
      const parsed = Number.parseInt(stripped, 10);
      return parsed > 0 ? parsed : null;
    }
  }
  return null;
}

/** Backend `_parse_aspect_ratio`: "<w>:<h>" (or "<w>/<h>") with positive numbers. */
export function parseAspectRatioParts(
  value: string | null | undefined,
): [number, number] | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const separator = raw.includes(":") ? ":" : "/";
  if (!raw.includes(separator)) return null;

  const separatorIndex = raw.indexOf(separator);
  const left = raw.slice(0, separatorIndex);
  const right = raw.slice(separatorIndex + 1);

  const widthPart = parsePythonFloat(left.trim());
  const heightPart = parsePythonFloat(right.trim());
  if (widthPart === null || heightPart === null) return null;

  if (widthPart <= 0 || heightPart <= 0) return null;
  return [widthPart, heightPart];
}

/**
 * Python `float(...)` accepts only a complete numeric literal (no trailing
 * garbage), unlike Number.parseFloat.
 */
function parsePythonFloat(text: string): number | null {
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Project resolution is interpreted as the short-edge length,
 * e.g. 720 at 16:9 → 1280×720.
 */
export function deriveTrueDimensionsFromShortEdge(
  aspectRatio: string,
  resolution: number,
): [number, number] | null {
  const parsed = parseAspectRatioParts(aspectRatio);
  if (!parsed) return null;

  const [widthPart, heightPart] = parsed;
  const ratio = widthPart / heightPart;
  if (ratio <= 0) return null;

  if (ratio >= 1) {
    const height = resolution;
    const width = Math.max(1, pythonRound(height * ratio));
    return [width, height];
  }
  const width = resolution;
  const height = Math.max(1, pythonRound(width / ratio));
  return [width, height];
}

function buildCandidate(
  targetWidth: number,
  targetHeight: number,
  width: number,
  height: number,
  stride: number,
  searchSteps: number,
): StridedDimensionsCandidate {
  const targetAr = targetWidth / targetHeight;
  const candidateAr = width / height;
  const distortion = candidateAr / targetAr;

  return {
    width,
    height,
    aspect_ratio: candidateAr,
    distortion,
    error: Math.abs(1 - distortion),
    area_delta: Math.abs(width * height - targetWidth * targetHeight),
    pixel_delta: Math.abs(width - targetWidth) + Math.abs(height - targetHeight),
    stride,
    search_steps: searchSteps,
  };
}

/**
 * Search dimensions near the target that are multiples of `stride`
 * (diffusion models require strided dims), minimising aspect-ratio error,
 * then area delta, then pixel delta. Candidate generation order matters:
 * the sort is stable and ties resolve to the earliest-added candidate,
 * exactly as in the backend.
 */
export function findBestStridedDimensions(
  targetWidth: number,
  targetHeight: number,
  stride: number,
  searchSteps: number,
): StridedDimensionsCandidate | null {
  if (targetWidth <= 0 || targetHeight <= 0 || stride <= 0 || searchSteps < 0) {
    return null;
  }

  const targetAr = targetWidth / targetHeight;
  const baseWidth = pythonRound(targetWidth / stride) * stride;
  const baseHeight = pythonRound(targetHeight / stride) * stride;

  const dedupe = new Set<string>();
  const candidates: StridedDimensionsCandidate[] = [];

  const addCandidate = (width: number, height: number): void => {
    if (width <= 0 || height <= 0) return;
    const key = `${width}x${height}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    candidates.push(
      buildCandidate(targetWidth, targetHeight, width, height, stride, searchSteps),
    );
  };

  // Width-anchored search
  for (let step = -searchSteps; step <= searchSteps; step += 1) {
    const widthCandidate = baseWidth + step * stride;
    if (widthCandidate <= 0) continue;
    const idealHeight = widthCandidate / targetAr;
    addCandidate(widthCandidate, Math.floor(idealHeight / stride) * stride);
    addCandidate(widthCandidate, Math.ceil(idealHeight / stride) * stride);
  }

  // Height-anchored search
  for (let step = -searchSteps; step <= searchSteps; step += 1) {
    const heightCandidate = baseHeight + step * stride;
    if (heightCandidate <= 0) continue;
    const idealWidth = heightCandidate * targetAr;
    addCandidate(Math.floor(idealWidth / stride) * stride, heightCandidate);
    addCandidate(Math.ceil(idealWidth / stride) * stride, heightCandidate);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.error !== b.error) return a.error - b.error;
    if (a.area_delta !== b.area_delta) return a.area_delta - b.area_delta;
    return a.pixel_delta - b.pixel_delta;
  });
  return candidates[0];
}

export interface AspectRatioProcessingPlanConfig {
  /** Allowed short-edge resolutions; out-of-range requests clamp to closest. */
  resolutions?: readonly number[];
  stride?: unknown;
  search_steps?: unknown;
  postprocess?: {
    enabled?: boolean;
    mode?: string;
    apply_to?: string;
  };
}

export interface AspectRatioProcessingPlanInput {
  targetAspectRatio: string | null | undefined;
  targetResolution: unknown;
  config?: AspectRatioProcessingPlanConfig;
}

export interface AspectRatioProcessingPlanResult {
  metadata: AspectRatioProcessingMetadata | null;
  warnings: ProcessingWarning[];
}

function resolveSearchSteps(raw: unknown): number {
  if (typeof raw === "boolean") return 2;
  if (typeof raw === "number" && Number.isInteger(raw)) return Math.max(0, raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Math.max(0, Number.parseInt(raw.trim(), 10));
  }
  return 2;
}

/**
 * Media-level counterpart of the backend `apply_aspect_ratio_processing`:
 * computes the same strided dispatch dimensions and postprocess target, but
 * performs no workflow mutation (the caller resizes media instead), so the
 * returned metadata always carries an empty `applied_nodes`.
 */
export function buildAspectRatioProcessingPlan(
  input: AspectRatioProcessingPlanInput,
): AspectRatioProcessingPlanResult {
  const warnings: ProcessingWarning[] = [];
  const config = input.config ?? {};

  const targetAspectRatio = input.targetAspectRatio;
  if (typeof targetAspectRatio !== "string" || !targetAspectRatio.trim()) {
    warnings.push({
      code: "aspect_ratio_processing_missing_target_aspect_ratio",
      message:
        "target_aspect_ratio is required when aspect_ratio_processing is enabled",
    });
    return { metadata: null, warnings };
  }

  let targetResolution = toStrictPositiveInteger(input.targetResolution);
  if (targetResolution === null) {
    warnings.push({
      code: "aspect_ratio_processing_invalid_target_resolution",
      message:
        "target_resolution must be a positive integer when aspect_ratio_processing is enabled",
      details: { target_resolution: input.targetResolution },
    });
    return { metadata: null, warnings };
  }

  const allowedResolutions = config.resolutions;
  if (Array.isArray(allowedResolutions) && allowedResolutions.length > 0) {
    if (!allowedResolutions.includes(targetResolution)) {
      const requested = targetResolution;
      // Array.isArray narrows the readonly array to any[]; keep `closest`
      // a number so assigning it doesn't widen targetResolution to null.
      let closest: number = allowedResolutions[0];
      for (const candidate of allowedResolutions) {
        if (Math.abs(candidate - requested) < Math.abs(closest - requested)) {
          closest = candidate;
        }
      }
      warnings.push({
        code: "aspect_ratio_processing_resolution_clamped",
        message: `target_resolution ${targetResolution} not in allowed resolutions; clamped to ${closest}`,
        details: {
          target_resolution: targetResolution,
          allowed_resolutions: [...allowedResolutions],
          clamped_to: closest,
        },
      });
      targetResolution = closest;
    }
  }

  const trueDims = deriveTrueDimensionsFromShortEdge(
    targetAspectRatio,
    targetResolution,
  );
  if (trueDims === null) {
    warnings.push({
      code: "aspect_ratio_processing_invalid_target_aspect_ratio",
      message:
        "target_aspect_ratio must follow a '<width>:<height>' format with positive numbers",
      details: { target_aspect_ratio: targetAspectRatio },
    });
    return { metadata: null, warnings };
  }

  const [trueWidth, trueHeight] = trueDims;
  const stride = toStrictPositiveInteger(config.stride) ?? 16;
  const searchSteps = resolveSearchSteps(config.search_steps);

  const best = findBestStridedDimensions(
    trueWidth,
    trueHeight,
    stride,
    searchSteps,
  );
  if (best === null) {
    warnings.push({
      code: "aspect_ratio_processing_candidate_search_failed",
      message: "Could not find valid strided dimensions from target dimensions",
      details: {
        target_width: trueWidth,
        target_height: trueHeight,
        stride,
        search_steps: searchSteps,
      },
    });
    return { metadata: null, warnings };
  }

  const postprocessConfig = config.postprocess;
  const postprocess: AspectRatioProcessingPostprocess = {
    enabled: postprocessConfig?.enabled ?? true,
    mode: "stretch_exact",
    apply_to: "all_visual_outputs",
    target_width: trueWidth,
    target_height: trueHeight,
  };
  if (
    typeof postprocessConfig?.mode === "string" &&
    postprocessConfig.mode.trim() &&
    postprocessConfig.mode.trim() !== "stretch_exact"
  ) {
    // The backend carries arbitrary mode strings through; the frontend type
    // only models the one mode the postprocessor implements.
    warnings.push({
      code: "aspect_ratio_processing_unsupported_postprocess_mode",
      message: `Unsupported postprocess mode '${postprocessConfig.mode.trim()}'; falling back to stretch_exact`,
    });
  }

  const metadata: AspectRatioProcessingMetadata = {
    enabled: true,
    requested: {
      aspect_ratio: targetAspectRatio,
      resolution: targetResolution,
      width: trueWidth,
      height: trueHeight,
    },
    strided: {
      width: best.width,
      height: best.height,
      aspect_ratio: best.aspect_ratio,
      distortion: best.distortion,
      error: best.error,
      stride: best.stride,
      search_steps: best.search_steps,
    },
    applied_nodes: [],
    postprocess,
  };

  return { metadata, warnings };
}
