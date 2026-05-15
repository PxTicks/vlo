import type {
  GeneratedCreationMetadata,
  GeneratedCreationReplayState,
  GeneratedCreationWorkflowInputSnapshot,
} from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import { getAssetById } from "../../userAssets/publicApi";
import { useTimelineStore } from "../../timeline";
import { normalizeTimelineSelection } from "../../timelineSelection";
import type { DerivedMaskMapping } from "../pipeline/types";
import {
  captureFramePngAtTick,
  pickPrimaryPreparedMaskFile,
  renderTimelineSelectionToMp4,
  renderTimelineSelectionToMp4WithDerivedMasks,
} from "../utils/inputSelection";
import {
  createAudioSelectionPlaceholderFile,
  extractAudioFromSelection,
} from "../utils/manualSlotMedia";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";
import { haveMatchingWorkflowNodes } from "../utils/workflowNodeSignature";
import * as comfyApi from "../services/comfyuiApi";
import { parseInputsFromApiWorkflow } from "../services/apiWorkflowInputs";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import {
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateWidgetKey,
} from "../services/frontendRuleState";
import {
  buildWorkflowReplayPipelineInputs,
  getWorkflowReplayPipelineValue,
} from "../services/workflowRules";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowMaskCroppingMode,
} from "../types";
import { TEMP_WORKFLOW_ID } from "./constants";
import { EMPTY_WORKFLOW_RULES } from "./workflowState";
import type {
  GenerationWorkflowState,
  WorkflowOption,
  WorkflowReplayPanelState,
} from "./types";

export async function resolveMetadataWorkflowMatch(
  workflowData: Record<string, unknown>,
  availableWorkflows: WorkflowOption[],
  preferredWorkflowSourceId: string | null = null,
): Promise<{
  availableWorkflows: WorkflowOption[];
  matchedWorkflow: WorkflowOption | null;
  rules: WorkflowRules;
  rulesWarnings: WorkflowRuleWarning[];
  rulesSourceId: string | null;
}> {
  let candidateWorkflows = availableWorkflows.filter(
    (workflow) => workflow.id !== TEMP_WORKFLOW_ID,
  );

  try {
    candidateWorkflows = await comfyApi.listWorkflows();
  } catch (error) {
    console.warn(
      "[Generation] Failed to refresh workflows for metadata match:",
      error,
    );
  }

  const preferredWorkflow =
    preferredWorkflowSourceId !== null
      ? candidateWorkflows.find(
          (workflow) => workflow.id === preferredWorkflowSourceId,
        ) ?? null
      : null;

  if (preferredWorkflowSourceId) {
    try {
      const response = await comfyApi.getWorkflowRules(preferredWorkflowSourceId);
      return {
        availableWorkflows: candidateWorkflows,
        matchedWorkflow: preferredWorkflow,
        rules: response.has_sidecar ? response.rules : EMPTY_WORKFLOW_RULES,
        rulesWarnings: response.warnings ?? [],
        rulesSourceId: preferredWorkflowSourceId,
      };
    } catch (error) {
      return {
        availableWorkflows: candidateWorkflows,
        matchedWorkflow: preferredWorkflow,
        rules: EMPTY_WORKFLOW_RULES,
        rulesWarnings: [
          {
            code: "rules_fetch_failed",
            message:
              error instanceof Error
                ? error.message
                : "Failed to fetch workflow rules; defaulting to inferred behavior",
          },
        ],
        rulesSourceId: preferredWorkflowSourceId,
      };
    }
  }

  const workflowMatches = await Promise.all(
    candidateWorkflows.map(async (workflow) => {
      try {
        const candidateGraph = await comfyApi.getWorkflowContent(workflow.id);
        return haveMatchingWorkflowNodes(workflowData, candidateGraph)
          ? workflow
          : null;
      } catch (error) {
        console.warn(
          "[Generation] Failed to compare workflow against metadata:",
          workflow.id,
          error,
        );
        return null;
      }
    }),
  );

  const matchedWorkflow =
    workflowMatches.find(
      (workflow): workflow is WorkflowOption => workflow !== null,
    ) ?? null;

  if (!matchedWorkflow) {
    return {
      availableWorkflows: candidateWorkflows,
      matchedWorkflow: null,
      rules: EMPTY_WORKFLOW_RULES,
      rulesWarnings: [],
      rulesSourceId: null,
    };
  }

  try {
    const response = await comfyApi.getWorkflowRules(matchedWorkflow.id);
    if (!response.has_sidecar) {
      return {
        availableWorkflows: candidateWorkflows,
        matchedWorkflow,
        rules: EMPTY_WORKFLOW_RULES,
        rulesWarnings: [],
        rulesSourceId: null,
      };
    }

    return {
      availableWorkflows: candidateWorkflows,
      matchedWorkflow,
      rules: response.rules,
      rulesWarnings: response.warnings ?? [],
      rulesSourceId: matchedWorkflow.id,
    };
  } catch (error) {
    return {
      availableWorkflows: candidateWorkflows,
      matchedWorkflow,
      rules: EMPTY_WORKFLOW_RULES,
      rulesWarnings: [
        {
          code: "rules_fetch_failed",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch workflow rules; defaulting to inferred behavior",
        },
      ],
      rulesSourceId: null,
    };
  }
}

export async function restoreMediaInputsFromMetadata(
  metadata: GeneratedCreationMetadata,
  workflowInputs: WorkflowInput[],
  derivedMaskMappings: DerivedMaskMapping[],
  actions: Pick<
    GenerationWorkflowState,
    | "setMediaInputAsset"
    | "setMediaInputFrameWithSelection"
    | "setMediaInputTimelineSelection"
  >,
): Promise<void> {
  const timelineClips = useTimelineStore.getState().clips;
  const workflowInputByNodeId = new Map<string, WorkflowInput>();
  for (const workflowInput of workflowInputs) {
    if (!workflowInputByNodeId.has(workflowInput.nodeId)) {
      workflowInputByNodeId.set(workflowInput.nodeId, workflowInput);
    }
  }

  for (const input of metadata.inputs) {
    const workflowInput = workflowInputByNodeId.get(input.nodeId);
    if (!workflowInput) {
      continue;
    }

    const inputId = getWorkflowInputId(workflowInput);

    if (input.kind === "draggedAsset") {
      const asset = getAssetById(input.parentAssetId);
      if (!asset) {
        throw new Error(
          `Could not restore generation input: missing asset ${input.parentAssetId}`,
        );
      }

      actions.setMediaInputAsset(inputId, asset);
      continue;
    }

    const timelineSelection = normalizeTimelineSelection(
      input.timelineSelection,
      timelineClips,
    );

    if (workflowInput.inputType === "image") {
      const frameFile = await captureFramePngAtTick(
        timelineSelection.start,
        "generation-frame",
        timelineSelection,
      );
      actions.setMediaInputFrameWithSelection(
        inputId,
        frameFile,
        timelineSelection,
      );
      continue;
    }

    const thumbnailFile =
      workflowInput.inputType === "audio"
        ? createAudioSelectionPlaceholderFile()
        : await captureFramePngAtTick(
            timelineSelection.start,
            "generation-selection-thumb",
            timelineSelection,
          );
    actions.setMediaInputTimelineSelection(
      inputId,
      timelineSelection,
      thumbnailFile,
      {
        mediaType: workflowInput.inputType === "audio" ? "audio" : "video",
        isExtracting: true,
        extractionRequestId: 1,
      },
    );

    // Extraction renders run in the background — the caller observes
    // completion via the mediaInputs `isExtracting` flag. Holding the
    // workflow-loading state through extraction would block panel edits
    // and re-submissions for the entire render duration.
    if (workflowInput.inputType === "audio") {
      void extractAudioFromSelection(timelineSelection, {
        exportFps: workflowInput.dispatch?.selectionConfig?.exportFps,
      })
        .then((preparedAudioFile) => {
          actions.setMediaInputTimelineSelection(
            inputId,
            timelineSelection,
            thumbnailFile,
            {
              mediaType: "audio",
              isExtracting: false,
              extractionRequestId: 1,
              preparedAudioFile,
              extractionError:
                preparedAudioFile === null
                  ? "No audio track was found in the selected timeline range"
                  : null,
            },
          );
        })
        .catch((error) => {
          actions.setMediaInputTimelineSelection(
            inputId,
            timelineSelection,
            thumbnailFile,
            {
              mediaType: "audio",
              isExtracting: false,
              extractionRequestId: 1,
              preparedAudioFile: null,
              extractionError:
                error instanceof Error
                  ? error.message
                  : "Failed to extract audio for timeline selection",
            },
          );
        });
      continue;
    }

    const sourceMappings = derivedMaskMappings.filter(
      (mapping) =>
        mapping.sourceInputId === inputId ||
        (!mapping.sourceInputId && mapping.sourceNodeId === workflowInput.nodeId),
    );

    if (sourceMappings.length > 0) {
      const cachedVisualMasks = sourceMappings.filter(
        (mapping) => mapping.purpose !== "audio_timing",
      );
      void renderTimelineSelectionToMp4WithDerivedMasks(
        timelineSelection,
        cachedVisualMasks,
      )
        .then(({ video, masks }) => {
          actions.setMediaInputTimelineSelection(
            inputId,
            timelineSelection,
            thumbnailFile,
            {
              mediaType: "video",
              isExtracting: false,
              extractionRequestId: 1,
              preparedVideoFile: video,
              preparedMaskFile: pickPrimaryPreparedMaskFile(
                cachedVisualMasks,
                masks,
              ),
            },
          );
        })
        .catch((error) => {
          actions.setMediaInputTimelineSelection(
            inputId,
            timelineSelection,
            thumbnailFile,
            {
              mediaType: "video",
              isExtracting: false,
              extractionRequestId: 1,
              preparedVideoFile: null,
              extractionError:
                error instanceof Error
                  ? error.message
                  : "Failed to extract timeline selection",
            },
          );
        });
      continue;
    }

    void renderTimelineSelectionToMp4(timelineSelection)
      .then((preparedVideoFile) => {
        actions.setMediaInputTimelineSelection(
          inputId,
          timelineSelection,
          thumbnailFile,
          {
            mediaType: "video",
            isExtracting: false,
            extractionRequestId: 1,
            preparedVideoFile,
          },
        );
      })
      .catch((error) => {
        actions.setMediaInputTimelineSelection(
          inputId,
          timelineSelection,
          thumbnailFile,
          {
            mediaType: "video",
            isExtracting: false,
            extractionRequestId: 1,
            preparedVideoFile: null,
            extractionError:
              error instanceof Error
                ? error.message
                : "Failed to extract timeline selection",
          },
        );
      });
  }
}

export function buildGeneratedCreationMetadata(
  options: {
    workflowName: string;
    workflowSourceId: string | null;
    workflowRules: WorkflowRules | null;
    workflowInputs: WorkflowInput[];
    mediaInputs: Record<string, GenerationMediaInputValue | null>;
    slotValues: Record<string, import("../utils/pipeline").SlotValue>;
    targetResolution: number;
    exactAspectRatio: boolean;
    maskCropMode: WorkflowMaskCroppingMode;
    maskCropDilation: number;
    frontendStateWidgetValues: Record<string, unknown>;
    widgetModes: Record<string, "fixed" | "randomize">;
    derivedWidgetInputs: Record<string, string>;
  },
): GeneratedCreationMetadata {
  const inputs: GeneratedCreationMetadata["inputs"] = [];
  const inputById = buildWorkflowInputLookup(options.workflowInputs);

  for (const workflowInput of options.workflowInputs) {
    const value = getWorkflowInputValue(
      options.mediaInputs,
      workflowInput,
      inputById,
    );
    if (!value) continue;

    if (value.kind === "timelineSelection") {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "timelineSelection",
        timelineSelection: cloneTimelineSelectionForMetadata(
          value.timelineSelection,
        ),
      });
      continue;
    }

    if (value.kind === "frame" && value.timelineSelection) {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "timelineSelection",
        timelineSelection: cloneTimelineSelectionForMetadata(
          value.timelineSelection,
        ),
      });
      continue;
    }

    if (value.kind === "asset") {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "draggedAsset",
        parentAssetId: value.asset.id,
      });
    }
  }

  const replayState = buildGeneratedCreationReplayState({
    workflowSourceId: options.workflowSourceId,
    workflowRules: options.workflowRules,
    workflowInputs: options.workflowInputs,
    slotValues: options.slotValues,
    frontendStateWidgetValues: options.frontendStateWidgetValues,
    widgetModes: options.widgetModes,
    derivedWidgetInputs: options.derivedWidgetInputs,
    exactAspectRatio: options.exactAspectRatio,
    targetResolution: options.targetResolution,
    maskCropMode: options.maskCropMode,
    maskCropDilation: options.maskCropDilation,
  });

  const metadata: GeneratedCreationMetadata = {
    source: "generated",
    workflowName: options.workflowName,
    inputs,
    targetResolution: options.targetResolution,
  };

  if (options.workflowSourceId) {
    metadata.workflowSourceId = options.workflowSourceId;
  }
  if (replayState) {
    metadata.replayState = replayState;
  }

  return metadata;
}

function cloneTimelineSelectionForMetadata(
  selection: TimelineSelection,
): TimelineSelection {
  return structuredClone(selection);
}

export function findPreparedMaskFallback(
  slotValues: Record<string, import("../utils/pipeline").SlotValue>,
  derivedMaskMappings: DerivedMaskMapping[],
  workflowInputs: WorkflowInput[],
): File | null {
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const inputsByNodeId = new Map<string, WorkflowInput[]>();
  for (const input of workflowInputs) {
    const existing = inputsByNodeId.get(input.nodeId) ?? [];
    existing.push(input);
    inputsByNodeId.set(input.nodeId, existing);
  }

  for (const mapping of derivedMaskMappings) {
    if (mapping.purpose === "audio_timing") {
      continue;
    }
    if (mapping.sourceInputId) {
      const sourceInput = inputById.get(mapping.sourceInputId);
      const value = sourceInput
        ? getWorkflowInputValue(slotValues, sourceInput, inputById)
        : slotValues[mapping.sourceInputId];
      if (value?.type === "video_selection" && value.preparedMaskFile) {
        return value.preparedMaskFile;
      }
      continue;
    }

    for (const input of inputsByNodeId.get(mapping.sourceNodeId) ?? []) {
      const value = getWorkflowInputValue(slotValues, input, inputById);
      if (value?.type === "video_selection" && value.preparedMaskFile) {
        return value.preparedMaskFile;
      }
    }
  }

  return null;
}

export function parseMetadataWorkflowInputs(
  prompt: Record<string, unknown> | null,
  inputNodeMap: import("../constants/inputNodeMap").InputNodeMap | null,
  objectInfo?: Record<string, unknown> | null,
): WorkflowInput[] {
  if (!prompt) return [];
  return parseInputsFromApiWorkflow(prompt, inputNodeMap, objectInfo);
}

export function parseReplayWorkflowInputs(
  replayState: GeneratedCreationReplayState | null | undefined,
): WorkflowInput[] {
  if (!Array.isArray(replayState?.workflowInputs)) {
    return [];
  }

  return replayState.workflowInputs.flatMap((snapshot) => {
    if (!isWorkflowInputSnapshot(snapshot)) {
      return [];
    }

    return [
      {
        id: snapshot.id,
        nodeId: snapshot.nodeId,
        classType: snapshot.classType,
        inputType: snapshot.inputType,
        param: snapshot.param,
        label: snapshot.label,
        description: snapshot.description ?? null,
        currentValue: null,
        origin: snapshot.origin,
        dispatch:
          snapshot.dispatch?.kind === "node"
            ? {
                kind: "node" as const,
                ...(snapshot.dispatch.selectionConfig
                  ? {
                      selectionConfig: {
                        ...snapshot.dispatch.selectionConfig,
                      },
                    }
                  : {}),
              }
            : undefined,
      },
    ];
  });
}

export function extractReplayPanelState(
  metadata: GeneratedCreationMetadata,
): WorkflowReplayPanelState | null {
  const replayState = metadata.replayState;
  if (!replayState) {
    return null;
  }

  const textValues = isStringRecord(replayState.textValues)
    ? replayState.textValues
    : {};
  const widgetValues = isStringRecord(replayState.widgetValues)
    ? replayState.widgetValues
    : {};
  const widgetModes = isWidgetModesRecord(replayState.widgetModes)
    ? replayState.widgetModes
    : {};
  const derivedWidgetValues = isStringRecord(replayState.derivedWidgetValues)
    ? replayState.derivedWidgetValues
    : {};

  if (
    Object.keys(textValues).length === 0 &&
    Object.keys(widgetValues).length === 0 &&
    Object.keys(widgetModes).length === 0 &&
    Object.keys(derivedWidgetValues).length === 0
  ) {
    return null;
  }

  return {
    textValues: { ...textValues },
    widgetValues: { ...widgetValues },
    widgetModes: { ...widgetModes },
    derivedWidgetValues: { ...derivedWidgetValues },
  };
}

export function mergeAppliedWidgetValuesIntoGenerationMetadata(
  metadata: GeneratedCreationMetadata,
  appliedWidgetValues: Readonly<Record<string, string>>,
): void {
  if (Object.keys(appliedWidgetValues).length === 0) {
    return;
  }

  const replayState: GeneratedCreationReplayState = metadata.replayState
    ? { ...metadata.replayState }
    : { version: 2 };
  const widgetValues = isStringRecord(replayState.widgetValues)
    ? { ...replayState.widgetValues }
    : {};
  const derivedWidgetValues = isStringRecord(replayState.derivedWidgetValues)
    ? { ...replayState.derivedWidgetValues }
    : {};

  let changed = false;
  for (const [key, value] of Object.entries(appliedWidgetValues)) {
    if (typeof value !== "string") {
      continue;
    }

    if (key.startsWith("derived:") && key.endsWith(":__value")) {
      const derivedWidgetId = key.slice("derived:".length, -":__value".length);
      if (derivedWidgetId.length === 0) {
        continue;
      }
      derivedWidgetValues[buildFrontendStateDerivedWidgetKey(derivedWidgetId)] =
        value;
      changed = true;
      continue;
    }

    const separatorIndex = key.lastIndexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
      continue;
    }

    const nodeId = key.slice(0, separatorIndex);
    const param = key.slice(separatorIndex + 1);
    widgetValues[buildFrontendStateWidgetKey(nodeId, param)] = value;
    changed = true;
  }

  if (!changed) {
    return;
  }

  replayState.widgetValues = widgetValues;
  if (Object.keys(derivedWidgetValues).length > 0) {
    replayState.derivedWidgetValues = derivedWidgetValues;
  }
  metadata.replayState = replayState;
}

function buildWorkflowInputSnapshot(
  workflowInput: WorkflowInput,
): GeneratedCreationWorkflowInputSnapshot {
  const snapshot: GeneratedCreationWorkflowInputSnapshot = {
    nodeId: workflowInput.nodeId,
    classType: workflowInput.classType,
    inputType: workflowInput.inputType,
    param: workflowInput.param,
    label: workflowInput.label,
    origin: workflowInput.origin,
  };

  if (workflowInput.id) {
    snapshot.id = workflowInput.id;
  }
  if (workflowInput.description !== undefined) {
    snapshot.description = workflowInput.description;
  }
  if (workflowInput.dispatch?.kind === "node") {
    snapshot.dispatch = {
      kind: "node",
      ...(workflowInput.dispatch.selectionConfig
        ? {
            selectionConfig: {
              ...(workflowInput.dispatch.selectionConfig.exportFps != null
                ? {
                    exportFps: workflowInput.dispatch.selectionConfig.exportFps,
                  }
                : {}),
              ...(workflowInput.dispatch.selectionConfig.frameStep != null
                ? {
                    frameStep: workflowInput.dispatch.selectionConfig.frameStep,
                  }
                : {}),
              ...(workflowInput.dispatch.selectionConfig.maxFrames != null
                ? {
                    maxFrames: workflowInput.dispatch.selectionConfig.maxFrames,
                  }
                : {}),
              ...(workflowInput.dispatch.selectionConfig.message?.trim()
                ? {
                    message: workflowInput.dispatch.selectionConfig.message.trim(),
                  }
                : {}),
              ...(workflowInput.dispatch.selectionConfig.includeTracks === true
                ? {
                    includeTracks: true,
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  return snapshot;
}

function buildGeneratedCreationReplayState(options: {
  workflowSourceId: string | null;
  workflowRules: WorkflowRules | null;
  workflowInputs: WorkflowInput[];
  slotValues: Record<string, import("../utils/pipeline").SlotValue>;
  frontendStateWidgetValues: Record<string, unknown>;
  widgetModes: Record<string, "fixed" | "randomize">;
  derivedWidgetInputs: Record<string, string>;
  exactAspectRatio: boolean;
  targetResolution: number;
  maskCropMode: WorkflowMaskCroppingMode;
  maskCropDilation: number;
}): GeneratedCreationReplayState | undefined {
  const textValues: Record<string, string> = {};
  for (const input of options.workflowInputs) {
    if (input.inputType !== "text") {
      continue;
    }
    const inputId = getWorkflowInputId(input);
    const slotValue = options.slotValues[inputId];
    if (slotValue?.type !== "text") {
      continue;
    }
    textValues[inputId] = slotValue.value;
  }

  const pipelineInputs = buildWorkflowReplayPipelineInputs(options.workflowRules, {
    targetResolution: options.targetResolution,
    maskCropMode: options.maskCropMode,
    maskCropDilation: options.maskCropDilation,
  });

  const replayState: GeneratedCreationReplayState = {
    version: 2,
    workflowInputs: options.workflowInputs.map(buildWorkflowInputSnapshot),
    exactAspectRatio: options.exactAspectRatio,
    maskCropMode: options.maskCropMode,
    maskCropDilation: options.maskCropDilation,
    ...(Object.keys(pipelineInputs).length > 0 ? { pipelineInputs } : {}),
  };

  if (options.workflowSourceId) {
    replayState.workflowSourceId = options.workflowSourceId;
  }
  if (Object.keys(textValues).length > 0) {
    replayState.textValues = textValues;
  }
  const serializedWidgetValues = Object.fromEntries(
    Object.entries(options.frontendStateWidgetValues).flatMap(([key, value]) =>
      value === undefined || value === null ? [] : [[key, String(value)]],
    ),
  );
  if (Object.keys(serializedWidgetValues).length > 0) {
    replayState.widgetValues = serializedWidgetValues;
  }
  if (Object.keys(options.widgetModes).length > 0) {
    replayState.widgetModes = { ...options.widgetModes };
  }
  if (Object.keys(options.derivedWidgetInputs).length > 0) {
    replayState.derivedWidgetValues = { ...options.derivedWidgetInputs };
  }

  return replayState;
}

export function getReplayTargetResolution(
  rules: WorkflowRules | null | undefined,
  metadata: GeneratedCreationMetadata,
): number | undefined {
  const replayState = metadata.replayState;
  const replayPipelineValue = getWorkflowReplayPipelineValue(
    rules,
    replayState?.pipelineInputs,
    { stageKind: "aspect_ratio", key: "target_resolution" },
  );
  if (typeof replayPipelineValue === "number") {
    return replayPipelineValue;
  }
  return typeof metadata.targetResolution === "number"
    ? metadata.targetResolution
    : undefined;
}

export function getReplayMaskCropMode(
  rules: WorkflowRules | null | undefined,
  replayState: GeneratedCreationReplayState | null | undefined,
): WorkflowMaskCroppingMode | undefined {
  const replayPipelineValue = getWorkflowReplayPipelineValue(
    rules,
    replayState?.pipelineInputs,
    { stageKind: "mask_processing", key: "crop_mode" },
  );
  if (replayPipelineValue === "crop" || replayPipelineValue === "full") {
    return replayPipelineValue;
  }
  return replayState?.maskCropMode;
}

export function getReplayMaskCropDilation(
  rules: WorkflowRules | null | undefined,
  replayState: GeneratedCreationReplayState | null | undefined,
): number | undefined {
  const replayPipelineValue = getWorkflowReplayPipelineValue(
    rules,
    replayState?.pipelineInputs,
    { stageKind: "mask_processing", key: "crop_dilation" },
  );
  if (typeof replayPipelineValue === "number") {
    return replayPipelineValue;
  }
  return typeof replayState?.maskCropDilation === "number"
    ? replayState.maskCropDilation
    : undefined;
}

function isWorkflowInputSnapshot(
  value: unknown,
): value is GeneratedCreationWorkflowInputSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<GeneratedCreationWorkflowInputSnapshot>;
  return (
    typeof candidate.nodeId === "string" &&
    typeof candidate.classType === "string" &&
    (candidate.inputType === "text" ||
      candidate.inputType === "image" ||
      candidate.inputType === "audio" ||
      candidate.inputType === "video") &&
    typeof candidate.param === "string" &&
    typeof candidate.label === "string" &&
    (candidate.origin === "rule" || candidate.origin === "inferred")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([key, entryValue]) => typeof key === "string" && typeof entryValue === "string",
  );
}

function isWidgetModesRecord(
  value: unknown,
): value is Record<string, "fixed" | "randomize"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (entryValue) => entryValue === "fixed" || entryValue === "randomize",
  );
}
