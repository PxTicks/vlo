import type { WorkflowInput } from "../types";
import { useProjectStore } from "../../project";
import { DEFAULT_GENERATION_TARGET_RESOLUTION } from "../services/workflowRules";
import { runProcessors } from "./runner";
import { FRONTEND_PREPROCESSORS } from "./preprocessors";
import { throwIfAborted } from "./utils/abort";
import { probeVisualFileAspectRatio } from "./utils/media";
import { getNodeInputRequestKey } from "../utils/workflowInputs";
import type {
  DerivedMaskMapping,
  FrontendPreprocessContext,
  FrontendPreprocessOptions,
  GenerationRequest,
  SlotValue,
} from "./types";

async function resolveTargetAspectRatio(
  ctx: FrontendPreprocessContext,
): Promise<string> {
  const maskNodeIds = new Set(
    ctx.derivedMaskMappings.map((mapping) => mapping.maskNodeId),
  );

  const resolveInputFile = (input: WorkflowInput): File | undefined => {
    const dispatch = input.dispatch;
    if (dispatch?.kind === "manual_slot") {
      if (dispatch.slotInputType === "image") {
        return ctx.manualSlotImageInputs[dispatch.slotId];
      }
      if (dispatch.slotInputType === "video") {
        return ctx.manualSlotVideoInputs[dispatch.slotId];
      }
      return undefined;
    }

    if (input.inputType === "image") {
      return ctx.imageInputs[getNodeInputRequestKey(input)];
    }
    if (input.inputType === "video") {
      return ctx.videoInputs[getNodeInputRequestKey(input)];
    }
    return undefined;
  };

  const probeInputs = async (
    inputs: readonly WorkflowInput[],
  ): Promise<string | null> => {
    for (const input of inputs) {
      if (input.inputType !== "image" && input.inputType !== "video") {
        continue;
      }
      const file = resolveInputFile(input);
      if (!file) continue;

      try {
        const aspectRatio = await probeVisualFileAspectRatio(file);
        if (aspectRatio) return aspectRatio;
      } catch (error) {
        console.warn(
          "[Generation] Failed to probe input aspect ratio",
          input.nodeId,
          error,
        );
      }
    }

    return null;
  };

  const preferredInputs = ctx.workflowInputs.filter(
    (input) => !maskNodeIds.has(input.nodeId),
  );
  const preferredAspectRatio = await probeInputs(preferredInputs);
  if (preferredAspectRatio) {
    return preferredAspectRatio;
  }

  const fallbackAspectRatio = await probeInputs(ctx.workflowInputs);
  return fallbackAspectRatio ?? ctx.projectConfig.aspectRatio;
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
  workflowInputs: WorkflowInput[],
  slotValues: Record<string, SlotValue>,
  clientId: string,
  derivedMaskMappings: DerivedMaskMapping[] = [],
  maskCropDilation?: number,
  options: FrontendPreprocessOptions = {},
  syncedGraphData: Record<string, unknown> | null = null,
): Promise<GenerationRequest> {
  const projectConfig = useProjectStore.getState().config;

  const ctx: FrontendPreprocessContext = {
    // Inputs
    syncedWorkflow,
    syncedGraphData,
    workflowId,
    workflowInputs,
    slotValues,
    derivedMaskMappings,
    projectConfig: {
      fps: projectConfig.fps,
      aspectRatio: projectConfig.aspectRatio,
    },
    targetResolution:
      options.targetResolution ?? DEFAULT_GENERATION_TARGET_RESOLUTION,
    clientId,
    maskCropDilation,
    maskCropMode: options.maskCropMode,
    signal: options.signal,

    // Accumulated outputs
    textInputs: {},
    imageInputs: {},
    videoInputs: {},
    manualSlotTextInputs: {},
    manualSlotImageInputs: {},
    manualSlotVideoInputs: {},
    manualSlotAudioInputs: {},
  };

  throwIfAborted(ctx.signal);
  await runProcessors(FRONTEND_PREPROCESSORS, ctx);
  throwIfAborted(ctx.signal);
  const targetAspectRatio = await resolveTargetAspectRatio(ctx);
  throwIfAborted(ctx.signal);

  return {
    workflow: ctx.syncedWorkflow,
    graphData: ctx.syncedGraphData,
    workflowId: ctx.workflowId,
    targetAspectRatio,
    targetResolution: ctx.targetResolution,
    textInputs: ctx.textInputs,
    imageInputs: ctx.imageInputs,
    videoInputs: ctx.videoInputs,
    manualSlotTextInputs: ctx.manualSlotTextInputs,
    manualSlotImageInputs: ctx.manualSlotImageInputs,
    manualSlotVideoInputs: ctx.manualSlotVideoInputs,
    manualSlotAudioInputs: ctx.manualSlotAudioInputs,
    maskCropDilation:
      ctx.derivedMaskMappings.length > 0 && ctx.maskCropMode !== "full"
        ? ctx.maskCropDilation
        : undefined,
    maskCropMode:
      ctx.derivedMaskMappings.length > 0 ? ctx.maskCropMode : undefined,
    clientId: ctx.clientId,
  };
}
