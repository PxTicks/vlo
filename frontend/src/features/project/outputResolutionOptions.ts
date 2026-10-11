/**
 * Output resolutions offered for a project, as the **short edge** in pixels.
 *
 * Short edge rather than height: it is the convention every render output
 * uses (`renderer/utils/dimensions.ts`), so one number describes both
 * orientations — 1080 means 1920x1080 in landscape and 1080x1920 in portrait.
 */
export type ProjectOutputResolution = number;

export type PresetProjectOutputResolution = 360 | 480 | 720 | 1080 | 2160;

export const PROJECT_OUTPUT_RESOLUTIONS = [
  360, 480, 720, 1080, 2160,
] as const satisfies readonly PresetProjectOutputResolution[];

export const DEFAULT_PROJECT_OUTPUT_RESOLUTION: ProjectOutputResolution = 1080;

export const MIN_PROJECT_OUTPUT_RESOLUTION = 16;
export const MAX_PROJECT_OUTPUT_RESOLUTION = 8192;

export const isPresetProjectOutputResolution = (
  value: unknown,
): value is PresetProjectOutputResolution =>
  (PROJECT_OUTPUT_RESOLUTIONS as readonly unknown[]).includes(value);

export function normalizeProjectOutputResolution(
  value: unknown,
): ProjectOutputResolution | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_PROJECT_OUTPUT_RESOLUTION ||
    value > MAX_PROJECT_OUTPUT_RESOLUTION ||
    value % 2 !== 0
  ) {
    return null;
  }
  return value;
}
