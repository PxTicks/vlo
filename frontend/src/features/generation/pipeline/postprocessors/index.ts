import type { FrontendPostprocessContext, Processor } from "../types";
import { aspectRatioResize } from "./aspectRatioResize";
import { fetchOutputs } from "./fetchOutputs";
import { frameAudioStitch } from "./frameAudioStitch";
import { importAssets } from "./importAssets";

/**
 * Ordered list of frontend postprocessors.
 *
 * Order matters:
 * 1. fetchOutputs — download all ComfyUI output files
 * 2. frameAudioStitch — optionally package frames+audio into a video
 * 3. aspectRatioResize — apply configured visual output resizing
 * 4. importAssets — import the chosen outputs and prepare preview metadata
 */
export const FRONTEND_POSTPROCESSORS: readonly Processor<FrontendPostprocessContext>[] =
  [fetchOutputs, frameAudioStitch, aspectRatioResize, importAssets];

export { aspectRatioResize, fetchOutputs, frameAudioStitch, importAssets };
