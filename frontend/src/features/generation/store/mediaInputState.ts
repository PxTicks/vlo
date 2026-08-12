import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import {
  buildWorkflowInputLookup,
  resolveWorkflowInputForSlot,
} from "../utils/workflowInputs";

export function revokePreviewUrl(
  value: GenerationMediaInputValue | null | undefined,
) {
  if (!value) return;
  if (value.kind === "frame") {
    URL.revokeObjectURL(value.previewUrl);
  } else if (value.kind === "timelineSelection") {
    URL.revokeObjectURL(value.thumbnailUrl);
  }
}

function isCompatibleMediaInput(
  inputType: WorkflowInput["inputType"] | undefined,
  value: GenerationMediaInputValue | null,
): boolean {
  if (!inputType || !value || inputType === "text") return false;

  if (inputType === "image") {
    return (
      value.kind === "frame" ||
      (value.kind === "asset" && assetMatchesType(value.asset, "image"))
    );
  }

  if (inputType === "audio") {
    return (
      (value.kind === "asset" && assetMatchesType(value.asset, "audio")) ||
      (value.kind === "timelineSelection" && value.mediaType === "audio")
    );
  }

  return (
    (value.kind === "timelineSelection" && value.mediaType === "video") ||
    (value.kind === "asset" && assetMatchesType(value.asset, "video"))
  );
}

export function pruneMediaInputs(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  workflowInputs: WorkflowInput[],
): Record<string, GenerationMediaInputValue | null> {
  const inputsById = buildWorkflowInputLookup(workflowInputs);
  const next: Record<string, GenerationMediaInputValue | null> = {};

  for (const [inputId, value] of Object.entries(mediaInputs)) {
    const inputType = resolveWorkflowInputForSlot(inputId, inputsById)?.inputType;
    if (isCompatibleMediaInput(inputType, value)) {
      next[inputId] = value;
    } else {
      revokePreviewUrl(value);
    }
  }

  return next;
}
