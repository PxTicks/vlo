import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import type { PromptResponse } from "../services/comfyuiApi";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import {
  getAspectRatioStage,
  getMaskProcessingStage,
} from "../services/workflowRules";
import {
  buildGeneratedCreationMetadata,
  findPreparedMaskFallback,
} from "../store/metadata";
import { frontendPreprocess } from "../utils/pipeline";
import type {
  DerivedMaskMapping,
  GenerationPlan,
  PreparedGeneration,
  ProjectConfig,
  SlotValue,
  SubmittedGeneration,
} from "./types";

interface CreateGenerationPlanOptions {
  workflow: Record<string, unknown> | null;
  graphData: Record<string, unknown> | null;
  workflowId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  workflowName: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  slotValues: Record<string, SlotValue>;
  derivedMaskMappings: DerivedMaskMapping[];
  exactAspectRatio: boolean;
  targetResolution: number;
  maskCropMode: import("../types").WorkflowMaskCroppingMode;
  maskCropDilation: number;
  widgetInputs: Record<string, string>;
  frontendStateWidgetValues: Record<string, unknown>;
  widgetModes: Record<string, "fixed" | "randomize">;
  derivedWidgetInputs: Record<string, string>;
  postprocessConfig: import("../types").WorkflowPostprocessingConfig;
  workflowWarnings: WorkflowRuleWarning[];
  projectConfig: ProjectConfig;
}

interface PrepareGenerationPlanOptions {
  clientId: string;
  signal?: AbortSignal;
}

const SAVE_IMAGE_WEBSOCKET_NODE_TYPES = new Set([
  "SaveImageWebsocket",
  "VLOSaveImageWebsocketBMP",
]);

function getSaveImageWebsocketNodeIds(
  workflow: Record<string, unknown> | null,
): Set<string> {
  const ids = new Set<string>();
  if (!workflow) return ids;

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      continue;
    }
    const nodeClassType = (node as { class_type?: unknown }).class_type;
    if (
      typeof nodeClassType === "string" &&
      SAVE_IMAGE_WEBSOCKET_NODE_TYPES.has(nodeClassType)
    ) {
      ids.add(nodeId);
    }
  }

  return ids;
}

function isWindowLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (value === globalThis) {
    return true;
  }

  if (typeof Window !== "undefined" && value instanceof Window) {
    return true;
  }

  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Window]" || tag === "[object DOMWindow]") {
    return true;
  }

  const candidate = value as {
    window?: unknown;
    self?: unknown;
  };
  return candidate.window === value || candidate.self === value;
}

function isDomNodeLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (typeof Node !== "undefined" && value instanceof Node) {
    return true;
  }

  const candidate = value as {
    nodeType?: unknown;
    nodeName?: unknown;
  };
  return (
    typeof candidate.nodeType === "number" &&
    typeof candidate.nodeName === "string"
  );
}

function cloneSerializableRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;

  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "function" || typeof candidate === "symbol") {
      return undefined;
    }
    if (isWindowLike(candidate) || isDomNodeLike(candidate)) {
      return undefined;
    }
    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) {
        return undefined;
      }
      seen.add(candidate);
    }
    return candidate;
  });

  return serialized ? (JSON.parse(serialized) as Record<string, unknown>) : null;
}

function cloneSerializableValue<T>(value: T): T {
  return cloneSerializableRecord({ value })?.value as T;
}

function cloneSlotValues(
  slotValues: Record<string, SlotValue>,
): Record<string, SlotValue> {
  const next: Record<string, SlotValue> = {};

  for (const [key, value] of Object.entries(slotValues)) {
    switch (value.type) {
      case "text":
      case "image":
      case "audio":
      case "video":
        next[key] = { ...value };
        break;
      case "video_selection":
        next[key] = {
          ...value,
          selection: {
            ...value.selection,
            clips: value.selection.clips.slice(),
          },
        };
        break;
    }
  }

  return next;
}

function decodeProcessedMaskVideo(processedMaskVideo: string): File {
  const binaryStr = atob(processedMaskVideo);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i += 1) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return new File([bytes], `generation-mask-${crypto.randomUUID()}.webm`, {
    type: "video/webm",
  });
}

export function createGenerationPlan(
  options: CreateGenerationPlanOptions,
): GenerationPlan {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    workflow: {
      workflow: cloneSerializableRecord(options.workflow),
      graphData: cloneSerializableRecord(options.graphData),
      workflowId: options.workflowId,
      workflowRules: cloneSerializableValue(options.workflowRules),
      workflowInputs: cloneSerializableValue(options.workflowInputs),
    },
    preprocess: {
      slotValues: cloneSlotValues(options.slotValues),
      derivedMaskMappings: cloneSerializableValue(options.derivedMaskMappings),
      projectConfig: {
        fps: options.projectConfig.fps,
        aspectRatio: options.projectConfig.aspectRatio,
      },
      exactAspectRatio: options.exactAspectRatio,
      targetResolution: options.targetResolution,
      maskCropDilation: options.maskCropDilation,
      maskCropMode: options.maskCropMode,
    },
    submission: {
      widgetInputs: { ...options.widgetInputs },
      frontendStateWidgetValues: cloneSerializableValue(
        options.frontendStateWidgetValues,
      ),
      widgetModes: { ...options.widgetModes },
      derivedWidgetInputs: { ...options.derivedWidgetInputs },
    },
    metadata: {
      generationMetadata: cloneSerializableValue(
        buildGeneratedCreationMetadata(
          {
            workflowName: options.workflowName,
            workflowSourceId: options.workflowId,
            workflowRules: options.workflowRules,
            workflowInputs: options.workflowInputs,
            mediaInputs: options.mediaInputs,
            slotValues: options.slotValues,
            targetResolution: options.targetResolution,
            exactAspectRatio: options.exactAspectRatio,
            maskCropMode: options.maskCropMode,
            maskCropDilation: options.maskCropDilation,
            frontendStateWidgetValues: options.frontendStateWidgetValues,
            widgetModes: options.widgetModes,
            derivedWidgetInputs: options.derivedWidgetInputs,
          },
        ),
      ),
      workflowWarnings: cloneSerializableValue(options.workflowWarnings),
    },
    postprocess: {
      config: {
        mode: options.postprocessConfig.mode,
        panel_preview: options.postprocessConfig.panel_preview,
        on_failure: options.postprocessConfig.on_failure,
        ...(options.postprocessConfig.stitch_fps != null
          ? { stitch_fps: options.postprocessConfig.stitch_fps }
          : {}),
      },
    },
  };
}

export async function prepareGenerationPlan(
  plan: GenerationPlan,
  options: PrepareGenerationPlanOptions,
): Promise<PreparedGeneration> {
  const request = await frontendPreprocess(
    plan.workflow.workflow,
    plan.workflow.workflowId,
    plan.workflow.workflowRules,
    plan.workflow.workflowInputs,
    plan.preprocess.slotValues,
    options.clientId,
    plan.preprocess.derivedMaskMappings,
    plan.preprocess.maskCropDilation,
    {
      exactAspectRatio: plan.preprocess.exactAspectRatio,
      maskCropMode: plan.preprocess.maskCropMode,
      projectConfig: plan.preprocess.projectConfig,
      signal: options.signal,
      targetResolution: plan.preprocess.targetResolution,
    },
    plan.workflow.graphData,
  );

  // Snapshot the widget mode, not a realized random value. The backend
  // resolves "randomize" controls per /generate request, so queued batches
  // still get fresh seeds and other randomized widget values.
  if (Object.keys(plan.submission.widgetInputs).length > 0) {
    request.widgetInputs = { ...plan.submission.widgetInputs };
  }
  if (Object.keys(plan.submission.widgetModes).length > 0) {
    request.widgetModes = { ...plan.submission.widgetModes };
  }
  if (Object.keys(plan.submission.derivedWidgetInputs).length > 0) {
    request.derivedWidgetInputs = { ...plan.submission.derivedWidgetInputs };
  }

  return {
    plan,
    request,
  };
}

export function buildSubmittedGeneration(
  prepared: PreparedGeneration,
  response: PromptResponse,
): SubmittedGeneration {
  const responseWarnings = Array.isArray(response.workflow_warnings)
    ? response.workflow_warnings
    : [];
  const appliedWidgetValues = response.applied_widget_values ?? {};
  const pipelineOutputs = response.pipeline_outputs ?? {};
  const aspectRatioStage = getAspectRatioStage(
    prepared.plan.workflow.workflowRules,
  );
  const aspectRatioProcessing =
    aspectRatioStage &&
    typeof pipelineOutputs[aspectRatioStage.id] === "object" &&
    pipelineOutputs[aspectRatioStage.id] !== null
      ? ((pipelineOutputs[aspectRatioStage.id]?.aspect_ratio_processing ??
          null) as SubmittedGeneration["aspectRatioProcessing"])
      : null;
  const generationMetadata = structuredClone(
    prepared.plan.metadata.generationMetadata,
  );

  const maskProcessingStage = getMaskProcessingStage(
    prepared.plan.workflow.workflowRules,
  );
  const maskPipelineOutput =
    maskProcessingStage &&
    typeof pipelineOutputs[maskProcessingStage.id] === "object" &&
    pipelineOutputs[maskProcessingStage.id] !== null
      ? pipelineOutputs[maskProcessingStage.id]
      : null;

  if (maskPipelineOutput?.mask_crop_metadata) {
    generationMetadata.maskCropMetadata =
      maskPipelineOutput.mask_crop_metadata as typeof generationMetadata.maskCropMetadata;
  }
  if (response.comfyui_prompt) {
    generationMetadata.comfyuiPrompt = response.comfyui_prompt;
  }
  if (prepared.plan.workflow.graphData) {
    generationMetadata.comfyuiWorkflow = prepared.plan.workflow.graphData;
  } else if (response.comfyui_workflow) {
    generationMetadata.comfyuiWorkflow = response.comfyui_workflow;
  }

  let preparedMaskFile = findPreparedMaskFallback(
    prepared.plan.preprocess.slotValues,
    prepared.plan.preprocess.derivedMaskMappings,
    prepared.plan.workflow.workflowInputs,
  );
  if (typeof maskPipelineOutput?.processed_mask_video === "string") {
    preparedMaskFile = decodeProcessedMaskVideo(
      maskPipelineOutput.processed_mask_video,
    );
  }

  const saveImageWebsocketNodeIds = getSaveImageWebsocketNodeIds(
    prepared.request.workflow,
  );

  return {
    prepared,
    promptId: response.prompt_id,
    responseWarnings,
    appliedWidgetValues,
    aspectRatioProcessing,
    generationMetadata,
    preparedMaskFile,
    usesSaveImageWebsocketOutputs: saveImageWebsocketNodeIds.size > 0,
    saveImageWebsocketNodeIds,
  };
}
