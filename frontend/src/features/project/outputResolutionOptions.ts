/**
 * Output resolutions offered for a project, as the **short edge** in pixels.
 *
 * Short edge rather than height: it is the convention every render output
 * uses (`renderer/utils/dimensions.ts`), so one number describes both
 * orientations — 1080 means 1920x1080 in landscape and 1080x1920 in portrait.
 */
export type ProjectOutputResolution = 480 | 720 | 1080 | 2160;

export const PROJECT_OUTPUT_RESOLUTIONS = [
  480, 720, 1080, 2160,
] as const satisfies readonly ProjectOutputResolution[];

export const DEFAULT_PROJECT_OUTPUT_RESOLUTION: ProjectOutputResolution = 1080;

export const isProjectOutputResolution = (
  value: unknown,
): value is ProjectOutputResolution =>
  (PROJECT_OUTPUT_RESOLUTIONS as readonly unknown[]).includes(value);
