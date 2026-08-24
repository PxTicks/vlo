import { toPositiveInteger } from "./shared";
import type { WorkflowRules, WorkflowResolutionLadder } from "./types";
import { getAspectRatioStage } from "./pipeline";

/** Steps used when a ladder omits its own `steps`. */
export const DEFAULT_RESOLUTION_LADDER_STEPS = 5;
/** Keeps slider marks readable and bounds work for malformed/unvalidated rules. */
export const MAX_RESOLUTION_LADDER_STEPS = 20;

export interface ResolutionLadder {
  min: number;
  max: number;
  steps: number;
}

/** Ladder used by workflows that declare neither a ladder nor a resolution list. */
export const DEFAULT_RESOLUTION_LADDER: ResolutionLadder = {
  min: 240,
  max: 720,
  steps: DEFAULT_RESOLUTION_LADDER_STEPS,
};

/** Widest short edge the custom override accepts, so a typo cannot dispatch a 1e6px job. */
export const MAX_CUSTOM_RESOLUTION = 4320;

/**
 * Interpolates a ladder into evenly spaced short edges, e.g. 240..720 in 5
 * steps -> [240, 360, 480, 600, 720].
 *
 * Interior rungs round to even numbers so every rung stays a legal video
 * dimension; the endpoints are always preserved exactly. Collapsed rungs
 * (a range too narrow for the requested step count) are de-duplicated, so the
 * result can be shorter than `steps`.
 */
export function interpolateResolutionLadder(
  ladder: ResolutionLadder,
): number[] {
  const min = toPositiveInteger(ladder.min) ?? DEFAULT_RESOLUTION_LADDER.min;
  const max = Math.max(min, toPositiveInteger(ladder.max) ?? min);
  const steps = Math.min(
    MAX_RESOLUTION_LADDER_STEPS,
    Math.max(2, Math.round(ladder.steps)),
  );

  const values: number[] = [];
  for (let index = 0; index < steps; index += 1) {
    const ratio = index / (steps - 1);
    const raw = min + (max - min) * ratio;
    // Endpoints are authored values and must survive verbatim; only the
    // interpolated interior is snapped to an even number.
    const value =
      index === 0 ? min : index === steps - 1 ? max : 2 * Math.round(raw / 2);
    if (!values.includes(value)) {
      values.push(value);
    }
  }
  return values.sort((a, b) => a - b);
}

function toResolutionLadder(
  raw: WorkflowResolutionLadder | null | undefined,
): ResolutionLadder | null {
  if (!raw) return null;
  const min = toPositiveInteger(raw.min);
  const max = toPositiveInteger(raw.max);
  if (min === null || max === null || max < min) return null;
  const steps =
    typeof raw.steps === "number" && Number.isFinite(raw.steps)
      ? Math.min(
          MAX_RESOLUTION_LADDER_STEPS,
          Math.max(2, Math.round(raw.steps)),
        )
      : DEFAULT_RESOLUTION_LADDER_STEPS;
  return { min, max, steps };
}

/**
 * The legacy `resolutions` whitelist. Unlike a ladder these clamp: a request
 * outside the list is snapped to the closest entry (frontend and backend
 * both). Ladder-configured workflows return `[]` here on purpose, which is
 * what lets the panel's custom override dispatch an arbitrary short edge.
 */
export function getSupportedWorkflowResolutions(
  rules: WorkflowRules | null | undefined,
): number[] {
  const aspectRatioStage = getAspectRatioStage(rules);
  if (!aspectRatioStage || aspectRatioStage.enabled === false) return [];
  const rawResolutions = aspectRatioStage.config?.resolutions ?? [];

  const seen = new Set<number>();
  const supported: number[] = [];
  for (const resolution of rawResolutions) {
    const normalized = toPositiveInteger(resolution);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    supported.push(normalized);
  }
  return supported;
}

export interface WorkflowResolutionLadderPresentation {
  /** The rungs the panel offers, ascending. */
  values: number[];
  /** The declared range, or `null` for a legacy whitelist (which clamps). */
  ladder: ResolutionLadder | null;
}

/**
 * The short-edge ladder a workflow presents, or `null` when it runs no aspect
 * ratio stage at all.
 *
 * A declared `resolution_ladder` wins; otherwise a legacy `resolutions`
 * whitelist is presented as its own rungs; otherwise the default ladder.
 */
export function getWorkflowResolutionLadder(
  rules: WorkflowRules | null | undefined,
): WorkflowResolutionLadderPresentation | null {
  const aspectRatioStage = getAspectRatioStage(rules);
  if (!aspectRatioStage || aspectRatioStage.enabled === false) return null;

  const ladder = toResolutionLadder(aspectRatioStage.config?.resolution_ladder);
  if (ladder) {
    return { values: interpolateResolutionLadder(ladder), ladder };
  }

  const whitelisted = getSupportedWorkflowResolutions(rules);
  if (whitelisted.length > 0) {
    return { values: [...whitelisted].sort((a, b) => a - b), ladder: null };
  }

  return {
    values: interpolateResolutionLadder(DEFAULT_RESOLUTION_LADDER),
    ladder: DEFAULT_RESOLUTION_LADDER,
  };
}

export function getClosestWorkflowResolution(
  targetResolution: number,
  supportedResolutions: readonly number[],
): number {
  const normalizedTarget = toPositiveInteger(targetResolution);
  if (supportedResolutions.length === 0 || normalizedTarget === null) {
    return targetResolution;
  }

  let closest = supportedResolutions[0];
  let closestDistance = Math.abs(closest - normalizedTarget);
  for (const resolution of supportedResolutions.slice(1)) {
    const distance = Math.abs(resolution - normalizedTarget);
    if (distance < closestDistance) {
      closest = resolution;
      closestDistance = distance;
    }
  }

  return closest;
}

/**
 * Normalizes a panel-entered short edge. Custom overrides are free-form, so
 * this only rejects nonsense (non-positive, absurdly large) rather than
 * snapping to a rung.
 */
export function normalizeCustomResolution(value: unknown): number | null {
  const normalized = toPositiveInteger(
    typeof value === "string" ? Number(value) : value,
  );
  if (normalized === null) return null;
  return Math.min(normalized, MAX_CUSTOM_RESOLUTION);
}
