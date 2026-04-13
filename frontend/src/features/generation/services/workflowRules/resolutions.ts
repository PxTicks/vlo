import { toPositiveInteger } from "./shared";
import type { WorkflowRules } from "./types";
import { getAspectRatioStage } from "./pipeline";

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
