import type { Asset } from "../../../types/Asset";
import type { GenerationMediaInputValue } from "../types";
import {
  buildWorkflowInputLookup,
  resolveWorkflowInputKeys,
} from "../utils/workflowInputs";
import { revokePreviewUrl } from "./mediaInputState";
import type {
  GenerationStoreSet,
  GenerationStoreGet,
  GenerationWorkflowState,
} from "./types";

function removeMediaInputEntries(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  inputIds: readonly string[],
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };

  for (const inputId of new Set(inputIds)) {
    revokePreviewUrl(next[inputId]);
    delete next[inputId];
  }

  return next;
}

export function buildMediaInputActions(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): Pick<
  GenerationWorkflowState,
  | "setMediaInputAsset"
  | "setMediaInputFrame"
  | "setMediaInputTimelineSelection"
  | "clearMediaInput"
> {
  return {
    setMediaInputAsset: (inputId, asset: Asset) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "asset",
          asset,
        }),
      }),

    setMediaInputFrame: (inputId, file) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "frame",
          file,
          previewUrl: URL.createObjectURL(file),
        }),
      }),

    setMediaInputTimelineSelection: (
      inputId,
      timelineSelection,
      thumbnailFile,
      options,
    ) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "timelineSelection",
          timelineSelection,
          thumbnailFile,
          thumbnailUrl: URL.createObjectURL(thumbnailFile),
          isExtracting: options?.isExtracting ?? false,
          extractionRequestId: options?.extractionRequestId ?? 0,
          preparedVideoFile: options?.preparedVideoFile ?? null,
          preparedMaskFile: options?.preparedMaskFile ?? null,
          preparedDerivedMaskVideoTreatment:
            options?.preparedDerivedMaskVideoTreatment ?? null,
          extractionError: options?.extractionError ?? null,
        }),
      }),

    clearMediaInput: (inputId) => {
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const hasMatchingEntry = inputKeys.some((key) =>
        Object.prototype.hasOwnProperty.call(mediaInputs, key),
      );
      if (!hasMatchingEntry) return;
      set({
        mediaInputs: removeMediaInputEntries(mediaInputs, inputKeys),
      });
    },
  };
}

function updateMediaInputs(
  get: GenerationStoreGet,
  inputId: string,
  value: GenerationMediaInputValue,
): Record<string, GenerationMediaInputValue | null> {
  const { workflowInputs, mediaInputs } = get();
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
  const canonicalInputId = inputKeys[0] ?? inputId;
  return {
    ...removeMediaInputEntries(mediaInputs, inputKeys),
    [canonicalInputId]: value,
  };
}
