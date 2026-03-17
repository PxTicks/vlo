/**
 * Ordered list of frontend preprocessors.
 *
 * The runner executes these sequentially. Each processor checks its own
 * activation condition and reads from / writes to the shared context.
 *
 * Order matters:
 * 1. collectTextInputs — simple text routing (no dependencies)
 * 2. collectImageInputs — simple image routing (no dependencies)
 * 3. collectVideoInputs — video normalization + derived mask rendering
 * 4. extractSlotAudio — audio extraction from video sources for audio slots
 */

import type { Processor, FrontendPreprocessContext } from "../types";
import { collectTextInputs } from "./collectTextInputs";
import { collectImageInputs } from "./collectImageInputs";
import { collectVideoInputs } from "./collectVideoInputs";
import { extractSlotAudio } from "./extractSlotAudio";

export const FRONTEND_PREPROCESSORS: readonly Processor<FrontendPreprocessContext>[] =
  [collectTextInputs, collectImageInputs, collectVideoInputs, extractSlotAudio];

export {
  collectTextInputs,
  collectImageInputs,
  collectVideoInputs,
  extractSlotAudio,
};
