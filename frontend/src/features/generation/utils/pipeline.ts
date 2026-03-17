import { runFrontendPostprocess } from "../pipeline/runPostprocess";
import { runFrontendPreprocess } from "../pipeline/runPreprocess";

// Canonical pipeline types live in pipeline/types.ts. This file remains as a
// temporary compatibility layer for existing imports.
export type {
  FrontendPostprocessOptions as FrontendPostprocessContext,
  FrontendPostprocessResult,
  GenerationRequest,
  SlotValue,
} from "../pipeline/types";

export const frontendPreprocess = runFrontendPreprocess;
export const frontendPostprocess = runFrontendPostprocess;
