import { getOutputMediaKindFromFile } from "../constants/mediaKinds";
import { DEFAULT_WORKFLOW_POSTPROCESSING } from "../services/workflowRules";
import type { WorkflowPostprocessingConfig } from "../types";
import { FRONTEND_POSTPROCESSORS } from "./postprocessors";
import { runProcessors } from "./runner";
import { toPositiveFps } from "./utils/fps";
import type {
  FrontendPostprocessContext,
  FrontendPostprocessOptions,
  FrontendPostprocessResult,
} from "./types";

function normalizePostprocessingConfig(
  postprocessing: FrontendPostprocessOptions["postprocessing"],
): WorkflowPostprocessingConfig {
  const requestedStitchFps = toPositiveFps(postprocessing?.stitch_fps);
  const config: WorkflowPostprocessingConfig = {
    mode: postprocessing?.mode ?? DEFAULT_WORKFLOW_POSTPROCESSING.mode ?? "auto",
    panel_preview:
      postprocessing?.panel_preview ??
      DEFAULT_WORKFLOW_POSTPROCESSING.panel_preview ??
      "raw_outputs",
    on_failure:
      postprocessing?.on_failure ??
      DEFAULT_WORKFLOW_POSTPROCESSING.on_failure ??
      "fallback_raw",
  };

  if (requestedStitchFps !== null) {
    config.stitch_fps = requestedStitchFps;
  }

  return config;
}

/**
 * Builds a {@link FrontendPostprocessContext}, runs all frontend postprocessors,
 * and returns the assembled postprocess result.
 *
 * This is the canonical entry point for frontend postprocessing. The legacy
 * `frontendPostprocess()` in `utils/pipeline.ts` delegates to this function.
 */
export async function runFrontendPostprocess(
  outputs: FrontendPostprocessContext["outputs"],
  options: FrontendPostprocessOptions,
): Promise<FrontendPostprocessResult> {
  const ctx: FrontendPostprocessContext = {
    // Inputs
    outputs,
    postprocessingConfig: normalizePostprocessingConfig(options.postprocessing),
    aspectRatioProcessing: options.aspectRatioProcessing ?? null,
    generationMetadata: options.generationMetadata,
    autoFamilyRequestKey: options.autoFamilyRequestKey ?? null,
    previewFrameFiles: (options.previewFrameFiles ?? []).filter(
      (file) => getOutputMediaKindFromFile(file) === "image",
    ),
    preparedMaskFile: options.preparedMaskFile ?? null,

    // Accumulated outputs
    fetchedFiles: [],
    frameFiles: [],
    audioFiles: [],
    videoFiles: [],
    packagedVideo: null,
    packagedVideoCompatibility: null,
    stitchFailure: null,
    stitchMessage: null,
    importedAssetIds: [],
    postprocessedPreview: null,
    postprocessError: null,
  };

  await runProcessors(FRONTEND_POSTPROCESSORS, ctx);

  ctx.postprocessError = ctx.stitchFailure ?? ctx.stitchMessage;

  return {
    postprocessedPreview: ctx.postprocessedPreview,
    postprocessError: ctx.postprocessError,
    importedAssetIds: ctx.importedAssetIds,
  };
}
