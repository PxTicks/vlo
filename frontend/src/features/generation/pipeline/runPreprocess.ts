import type { WorkflowInput } from "../types";
import { useProjectStore } from "../../project";
import {
  DEFAULT_GENERATION_TARGET_RESOLUTION,
  getAspectRatioStage,
  getMaskProcessingStage,
  getWorkflowStageControl,
} from "../services/workflowRules";
import type { WorkflowRules } from "../services/workflowRules";
import { runProcessors } from "./runner";
import { FRONTEND_PREPROCESSORS } from "./preprocessors";
import { throwIfAborted } from "./utils/abort";
import type {
  DerivedMaskMapping,
  FrontendPreprocessContext,
  FrontendPreprocessOptions,
  GenerationRequest,
  SlotValue,
} from "./types";

function buildPipelineInputs(
  ctx: FrontendPreprocessContext,
): Record<string, Record<string, unknown>> {
  const pipelineInputs: Record<string, Record<string, unknown>> = {};

  const aspectRatioStage = getAspectRatioStage(ctx.workflowRules);
  if (aspectRatioStage) {
    const stageInputs: Record<string, unknown> = {};
    if (getWorkflowStageControl(aspectRatioStage, "target_aspect_ratio")) {
      stageInputs.target_aspect_ratio = ctx.targetAspectRatio;
    }
    if (getWorkflowStageControl(aspectRatioStage, "target_resolution")) {
      stageInputs.target_resolution = ctx.targetResolution;
    }
    if (Object.keys(stageInputs).length > 0) {
      pipelineInputs[aspectRatioStage.id] = stageInputs;
    }
  }

  const maskProcessingStage = getMaskProcessingStage(ctx.workflowRules);
  if (maskProcessingStage && ctx.derivedMaskMappings.length > 0) {
    const stageInputs: Record<string, unknown> = {};
    if (getWorkflowStageControl(maskProcessingStage, "crop_mode")) {
      stageInputs.crop_mode = ctx.maskCropMode ?? "crop";
    }
    if (
      getWorkflowStageControl(maskProcessingStage, "crop_dilation") &&
      ctx.maskCropMode !== "full" &&
      ctx.maskCropDilation != null
    ) {
      stageInputs.crop_dilation = ctx.maskCropDilation;
    }
    if (Object.keys(stageInputs).length > 0) {
      pipelineInputs[maskProcessingStage.id] = stageInputs;
    }
  }

  return pipelineInputs;
}

/**
 * Builds a {@link FrontendPreprocessContext}, runs all frontend preprocessors,
 * and returns the assembled {@link GenerationRequest}.
 *
 * This is the canonical entry point for frontend preprocessing. The legacy
 * `frontendPreprocess()` in `utils/pipeline.ts` delegates to this function.
 */
export async function runFrontendPreprocess(
  syncedWorkflow: Record<string, unknown> | null,
  workflowId: string | null,
  workflowRules: WorkflowRules | null,
  workflowInputs: WorkflowInput[],
  slotValues: Record<string, SlotValue>,
  clientId: string,
  derivedMaskMappings: DerivedMaskMapping[] = [],
  maskCropDilation?: number,
  options: FrontendPreprocessOptions = {},
  syncedGraphData: Record<string, unknown> | null = null,
): Promise<GenerationRequest> {
  const projectConfig = options.projectConfig ?? useProjectStore.getState().config;

  const ctx: FrontendPreprocessContext = {
    // Inputs
    syncedWorkflow,
    syncedGraphData,
    workflowId,
    workflowRules,
    workflowInputs,
    slotValues,
    derivedMaskMappings,
    projectConfig: {
      fps: projectConfig.fps,
      aspectRatio: projectConfig.aspectRatio,
    },
    exactAspectRatio: options.exactAspectRatio ?? false,
    targetResolution:
      options.targetResolution ?? DEFAULT_GENERATION_TARGET_RESOLUTION,
    clientId,
    maskCropDilation,
    maskCropMode: options.maskCropMode,
    signal: options.signal,

    // Accumulated outputs
    targetAspectRatio: projectConfig.aspectRatio,
    textInputs: {},
    imageInputs: {},
    audioInputs: {},
    videoInputs: {},
    pipelineInputs: {},
  };

  throwIfAborted(ctx.signal);
  await runProcessors(FRONTEND_PREPROCESSORS, ctx);
  throwIfAborted(ctx.signal);

  ctx.pipelineInputs = buildPipelineInputs(ctx);

  return {
    workflow: ctx.syncedWorkflow,
    graphData: ctx.syncedGraphData,
    workflowId: ctx.workflowId,
    exactAspectRatio: ctx.exactAspectRatio,
    textInputs: ctx.textInputs,
    imageInputs: ctx.imageInputs,
    videoInputs: ctx.videoInputs,
    audioInputs: ctx.audioInputs,
    pipelineInputs: ctx.pipelineInputs,
    clientId: ctx.clientId,
  };
}
