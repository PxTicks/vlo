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
  options: { revoke?: boolean } = {},
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };
  const shouldRevoke = options.revoke !== false;

  for (const inputId of new Set(inputIds)) {
    if (shouldRevoke) {
      revokePreviewUrl(next[inputId]);
    }
    delete next[inputId];
  }

  return next;
}

function getExistingMediaInputValue(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  inputIds: readonly string[],
): GenerationMediaInputValue | null {
  for (const inputId of inputIds) {
    if (Object.prototype.hasOwnProperty.call(mediaInputs, inputId)) {
      return mediaInputs[inputId] ?? null;
    }
  }

  return null;
}

export function buildMediaInputActions(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): Pick<
  GenerationWorkflowState,
  | "setMediaInputAsset"
  | "setMediaInputFrame"
  | "setMediaInputFrameWithSelection"
  | "setMediaInputTimelineSelection"
  | "reassignMediaInput"
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
          timelineSelection: null,
        }),
      }),

    setMediaInputFrameWithSelection: (inputId, file, timelineSelection) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "frame",
          file,
          previewUrl: URL.createObjectURL(file),
          timelineSelection,
        }),
      }),

    setMediaInputTimelineSelection: (
      inputId,
      timelineSelection,
      thumbnailFile,
      options,
    ) =>
      set({
        mediaInputs: updateMediaInputs(
          get,
          inputId,
          (options?.mediaType ?? "video") === "audio"
            ? {
                kind: "timelineSelection",
                mediaType: "audio",
                timelineSelection,
                thumbnailFile,
                thumbnailUrl: URL.createObjectURL(thumbnailFile),
                isExtracting: options?.isExtracting ?? false,
                extractionRequestId: options?.extractionRequestId ?? 0,
                preparedAudioFile: options?.preparedAudioFile ?? null,
                extractionError: options?.extractionError ?? null,
              }
            : {
                kind: "timelineSelection",
                mediaType: "video",
                timelineSelection,
                thumbnailFile,
                thumbnailUrl: URL.createObjectURL(thumbnailFile),
                isExtracting: options?.isExtracting ?? false,
                extractionRequestId: options?.extractionRequestId ?? 0,
                preparedVideoFile: options?.preparedVideoFile ?? null,
                preparedMaskFile: options?.preparedMaskFile ?? null,
                preparedDerivedMaskSignature:
                  options?.preparedDerivedMaskSignature ?? null,
                extractionError: options?.extractionError ?? null,
              },
        ),
      }),

    reassignMediaInput: (sourceInputId, targetInputId) =>
      set({
        mediaInputs: reassignMediaInputs(get, sourceInputId, targetInputId),
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

function reassignMediaInputs(
  get: GenerationStoreGet,
  sourceInputId: string,
  targetInputId: string,
): Record<string, GenerationMediaInputValue | null> {
  const { workflowInputs, mediaInputs } = get();
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const sourceInput = inputById.get(sourceInputId);
  const targetInput = inputById.get(targetInputId);

  if (!sourceInput || !targetInput) {
    return mediaInputs;
  }

  if (
    sourceInput.inputType !== targetInput.inputType ||
    sourceInput.inputType === "text"
  ) {
    return mediaInputs;
  }

  const sourceKeys = resolveWorkflowInputKeys(sourceInputId, inputById);
  const targetKeys = resolveWorkflowInputKeys(targetInputId, inputById);
  const sourceCanonicalInputId = sourceKeys[0] ?? sourceInputId;
  const targetCanonicalInputId = targetKeys[0] ?? targetInputId;

  if (sourceCanonicalInputId === targetCanonicalInputId) {
    return mediaInputs;
  }

  const sourceValue = getExistingMediaInputValue(mediaInputs, sourceKeys);
  if (!sourceValue) {
    return mediaInputs;
  }

  const targetValue = getExistingMediaInputValue(mediaInputs, targetKeys);
  const next = removeMediaInputEntries(
    mediaInputs,
    [...sourceKeys, ...targetKeys],
    { revoke: false },
  );

  next[targetCanonicalInputId] = sourceValue;
  if (targetValue) {
    next[sourceCanonicalInputId] = targetValue;
  }

  return next;
}
