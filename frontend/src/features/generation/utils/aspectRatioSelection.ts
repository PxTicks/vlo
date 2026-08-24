import { PROJECT_ASPECT_RATIOS } from "../../project";
import type { AspectRatio } from "../../project";

/**
 * Probe the supplied media for its aspect ratio, falling back to the open
 * project's when there is nothing to probe. The default, and the behavior the
 * panel had before the selector existed.
 */
export const ASPECT_RATIO_SELECTION_AUTO = "auto";

/**
 * What the panel's aspect ratio selector holds: {@link
 * ASPECT_RATIO_SELECTION_AUTO}, or a literal `"<w>:<h>"` ratio the user pinned.
 */
export type GenerationAspectRatioSelection =
  | typeof ASPECT_RATIO_SELECTION_AUTO
  | AspectRatio;

export const DEFAULT_ASPECT_RATIO_SELECTION: GenerationAspectRatioSelection =
  ASPECT_RATIO_SELECTION_AUTO;

export function getAspectRatioSelectionOptions(): GenerationAspectRatioSelection[] {
  return [ASPECT_RATIO_SELECTION_AUTO, ...PROJECT_ASPECT_RATIOS];
}

export function getAspectRatioSelectionLabels(
  projectAspectRatio: string,
): Record<string, string> {
  const labels: Record<string, string> = {
    // Naming the project ratio here says what "auto" settles on when a
    // generation has no visual input to probe.
    [ASPECT_RATIO_SELECTION_AUTO]: `Auto (input, else ${projectAspectRatio})`,
  };
  for (const ratio of PROJECT_ASPECT_RATIOS) {
    labels[ratio] = ratio;
  }
  return labels;
}

export function isAspectRatioSelection(
  value: unknown,
): value is GenerationAspectRatioSelection {
  return (
    typeof value === "string" &&
    getAspectRatioSelectionOptions().some((option) => option === value)
  );
}

/**
 * Anything unrecognized — including the absent selection on assets generated
 * before the selector existed — reads as `"auto"`, which is what those
 * generations actually did.
 */
export function normalizeAspectRatioSelection(
  value: unknown,
): GenerationAspectRatioSelection {
  return isAspectRatioSelection(value) ? value : DEFAULT_ASPECT_RATIO_SELECTION;
}

/**
 * Resolves a selection to the aspect ratio to dispatch at, or `null` for
 * `"auto"` — the one case that probes the supplied media and only falls back
 * to the project ratio when nothing can be probed.
 */
export function resolveAspectRatioSelection(
  selection: GenerationAspectRatioSelection | null | undefined,
): string | null {
  const normalized = normalizeAspectRatioSelection(selection);
  return normalized === ASPECT_RATIO_SELECTION_AUTO ? null : normalized;
}
