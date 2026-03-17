import type { GenerationMediaInputValue, WorkflowInput } from "../types";

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
  const inputsByNodeId = new Map(
    workflowInputs.map((input) => [input.nodeId, input.inputType]),
  );
  const next: Record<string, GenerationMediaInputValue | null> = {};

  for (const [nodeId, value] of Object.entries(mediaInputs)) {
    const inputType = inputsByNodeId.get(nodeId);
    if (isCompatibleMediaInput(inputType, value)) {
      next[nodeId] = value;
    } else {
      revokePreviewUrl(value);
    }
  }

  return next;
}
