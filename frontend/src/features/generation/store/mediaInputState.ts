import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import { buildWorkflowInputLookup } from "../utils/workflowInputs";

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
      (value.kind === "asset" && value.asset.type === "image")
    );
  }

  return (
    value.kind === "timelineSelection" ||
    (value.kind === "asset" && value.asset.type === "video")
  );
}

export function pruneMediaInputs(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  workflowInputs: WorkflowInput[],
): Record<string, GenerationMediaInputValue | null> {
  const inputsById = buildWorkflowInputLookup(workflowInputs);
  const next: Record<string, GenerationMediaInputValue | null> = {};

  for (const [inputId, value] of Object.entries(mediaInputs)) {
    const inputType = inputsById.get(inputId)?.inputType;
    if (isCompatibleMediaInput(inputType, value)) {
      next[inputId] = value;
    } else {
      revokePreviewUrl(value);
    }
  }

  return next;
}
