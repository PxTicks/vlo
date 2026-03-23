import type { GeneratedCreationMetadata } from "../../../types/Asset";
import { getAssetById } from "../../userAssets/publicApi";
import type { DerivedMaskMapping } from "../pipeline/types";
import {
  captureFramePngAtTick,
  renderTimelineSelectionToWebm,
  renderTimelineSelectionToWebmWithMask,
} from "../utils/inputSelection";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";
import { haveMatchingWorkflowNodes } from "../utils/workflowNodeSignature";
import { DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT } from "../derivedMaskVideoTreatment";
import * as comfyApi from "../services/comfyuiApi";
import { parseWorkflowInputs } from "../services/workflowBridge";
import type {
  WorkflowRuleWarning,
  WorkflowRules,
} from "../services/workflowRules";
import type { WorkflowInput } from "../types";
import { TEMP_WORKFLOW_ID } from "./constants";
import { EMPTY_WORKFLOW_RULES } from "./workflowState";
import type { GenerationWorkflowState, WorkflowOption } from "./types";

export async function resolveMetadataWorkflowMatch(
  workflowData: Record<string, unknown>,
  availableWorkflows: WorkflowOption[],
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
    "setMediaInputAsset" | "setMediaInputTimelineSelection"
  >,
): Promise<void> {
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

    const thumbnailFile = await captureFramePngAtTick(
      input.timelineSelection.start,
      "generation-selection-thumb",
    );
    actions.setMediaInputTimelineSelection(
      inputId,
      input.timelineSelection,
      thumbnailFile,
      {
        isExtracting: true,
        extractionRequestId: 1,
      },
    );

    const derivedMaskMapping = derivedMaskMappings.find(
      (mapping) =>
        mapping.sourceInputId === inputId ||
        (!mapping.sourceInputId && mapping.sourceNodeId === workflowInput.nodeId),
    );

    if (derivedMaskMapping) {
      const { video, mask } = await renderTimelineSelectionToWebmWithMask(
        input.timelineSelection,
        derivedMaskMapping.maskType,
        {
          videoTreatment: DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
        },
      );

      actions.setMediaInputTimelineSelection(
        inputId,
        input.timelineSelection,
        thumbnailFile,
        {
          isExtracting: false,
          extractionRequestId: 1,
          preparedVideoFile: video,
          preparedMaskFile: mask,
          preparedDerivedMaskVideoTreatment:
            DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
        },
      );
      continue;
    }

    const preparedVideoFile = await renderTimelineSelectionToWebm(
      input.timelineSelection,
    );
    actions.setMediaInputTimelineSelection(
      inputId,
      input.timelineSelection,
      thumbnailFile,
      {
        isExtracting: false,
        extractionRequestId: 1,
        preparedVideoFile,
      },
    );
  }
}

export function buildGeneratedCreationMetadata(
  workflowName: string,
  workflowInputs: WorkflowInput[],
  mediaInputs: Record<string, import("../types").GenerationMediaInputValue | null>,
): GeneratedCreationMetadata {
  const inputs: GeneratedCreationMetadata["inputs"] = [];
  const inputById = buildWorkflowInputLookup(workflowInputs);

  for (const workflowInput of workflowInputs) {
    const value = getWorkflowInputValue(mediaInputs, workflowInput, inputById);
    if (!value) continue;

    if (value.kind === "timelineSelection") {
      inputs.push({
        nodeId: workflowInput.nodeId,
        kind: "timelineSelection",
        timelineSelection: value.timelineSelection,
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

  return {
    source: "generated",
    workflowName,
    inputs,
  };
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
): WorkflowInput[] {
  if (!prompt) return [];
  return parseWorkflowInputs(prompt, inputNodeMap);
}
