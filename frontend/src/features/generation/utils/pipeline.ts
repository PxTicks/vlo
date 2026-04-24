import { runFrontendPostprocess } from "../pipeline/runPostprocess";
import { runFrontendPreprocess } from "../pipeline/runPreprocess";
import type { WorkflowInput } from "../types";
import type { WorkflowRules } from "../services/workflowRules";
import type {
  DerivedMaskMapping,
  FrontendPreprocessOptions,
} from "../pipeline/types";

// Canonical pipeline types live in pipeline/types.ts. This file remains as a
// temporary compatibility layer for existing imports.
export type {
  FrontendPostprocessOptions as FrontendPostprocessContext,
  FrontendPostprocessResult,
  GenerationRequest,
  SlotValue,
} from "../pipeline/types";

export async function frontendPreprocess(
  syncedWorkflow: Record<string, unknown> | null,
  workflowId: string | null,
  workflowRulesOrInputs: WorkflowRules | WorkflowInput[] | null,
  workflowInputsOrSlotValues:
    | WorkflowInput[]
    | Record<string, import("../pipeline/types").SlotValue>,
  slotValuesOrClientId:
    | Record<string, import("../pipeline/types").SlotValue>
    | string,
  clientIdOrDerivedMaskMappings: string | DerivedMaskMapping[] = "",
  derivedMaskMappingsOrMaskCropDilation: DerivedMaskMapping[] | number | undefined = [],
  maskCropDilationOrOptions: number | FrontendPreprocessOptions | undefined = undefined,
  optionsOrGraphData:
    | FrontendPreprocessOptions
    | Record<string, unknown>
    | null
    | undefined = undefined,
  syncedGraphDataArg?: Record<string, unknown> | null,
) {
  if (Array.isArray(workflowRulesOrInputs)) {
    return runFrontendPreprocess(
      syncedWorkflow,
      workflowId,
      null,
      workflowRulesOrInputs,
      (workflowInputsOrSlotValues as Record<string, import("../pipeline/types").SlotValue>) ??
        {},
      typeof slotValuesOrClientId === "string" ? slotValuesOrClientId : "",
      Array.isArray(clientIdOrDerivedMaskMappings)
        ? clientIdOrDerivedMaskMappings
        : [],
      typeof derivedMaskMappingsOrMaskCropDilation === "number"
        ? derivedMaskMappingsOrMaskCropDilation
        : undefined,
      (
        typeof maskCropDilationOrOptions === "object" &&
        maskCropDilationOrOptions !== null
          ? maskCropDilationOrOptions
          : optionsOrGraphData && !Array.isArray(optionsOrGraphData)
            ? (optionsOrGraphData as FrontendPreprocessOptions)
            : {}
      ) ?? {},
      syncedGraphDataArg ??
        (typeof optionsOrGraphData === "object" &&
        optionsOrGraphData !== null &&
        !("targetResolution" in optionsOrGraphData) &&
        !("maskCropMode" in optionsOrGraphData) &&
        !("projectConfig" in optionsOrGraphData)
          ? (optionsOrGraphData as Record<string, unknown>)
          : null),
    );
  }

  return runFrontendPreprocess(
    syncedWorkflow,
    workflowId,
    workflowRulesOrInputs,
    Array.isArray(workflowInputsOrSlotValues) ? workflowInputsOrSlotValues : [],
    typeof slotValuesOrClientId === "object" && slotValuesOrClientId !== null
      ? slotValuesOrClientId
      : {},
    typeof clientIdOrDerivedMaskMappings === "string"
      ? clientIdOrDerivedMaskMappings
      : "",
    Array.isArray(derivedMaskMappingsOrMaskCropDilation)
      ? derivedMaskMappingsOrMaskCropDilation
      : [],
    typeof maskCropDilationOrOptions === "number"
      ? maskCropDilationOrOptions
      : undefined,
    (
      typeof optionsOrGraphData === "object" &&
      optionsOrGraphData !== null &&
      !Array.isArray(optionsOrGraphData)
        ? (optionsOrGraphData as FrontendPreprocessOptions)
        : {}
    ) ?? {},
    syncedGraphDataArg ?? null,
  );
}

export const frontendPostprocess = runFrontendPostprocess;
