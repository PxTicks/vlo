import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowInputItemOption,
} from "../types";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  parseRepeatableInputSlotId,
  resolveWorkflowInputKeys,
  resolveWorkflowInputForSlot,
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

/**
 * Reads the ordered contents of a repeatable input, densely: batch slots are
 * kept contiguous (clearing shifts the tail down), so the list index is the
 * delivery position the nodes will see.
 */
function readRepeatableSlotValues(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  max: number,
): Array<{ slotId: string; value: GenerationMediaInputValue }> {
  const entries: Array<{ slotId: string; value: GenerationMediaInputValue }> = [];
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    const keys =
      index === 0 ? resolveWorkflowInputKeys(slotId, inputById) : [slotId];
    const value = getExistingMediaInputValue(mediaInputs, keys);
    if (value) {
      entries.push({ slotId, value });
    }
  }
  return entries;
}

/** Writes an ordered list back over a repeatable input's slots, front-packed. */
function writeRepeatableSlotValues(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  max: number,
  values: readonly GenerationMediaInputValue[],
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    const keys =
      index === 0 ? resolveWorkflowInputKeys(slotId, inputById) : [slotId];
    for (const key of keys) {
      delete next[key];
    }
    const value = values[index];
    if (value) {
      // The canonical key is the one the rest of the store reads through.
      next[keys[0] ?? slotId] = value;
    }
  }
  return next;
}

/**
 * Front-packs a repeatable input so its occupied slots stay contiguous. Slot
 * order is delivery order, and the panel presents the batch densely, so a hole
 * left behind by a value moving out would silently reorder what the nodes
 * receive the next time an item is added.
 */
function compactRepeatableInput(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param" | "presentation">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
): Record<string, GenerationMediaInputValue | null> {
  const repeatableMax = input.presentation?.repeatable?.max;
  if (!repeatableMax) {
    return mediaInputs;
  }
  const entries = readRepeatableSlotValues(
    mediaInputs,
    input,
    inputById,
    repeatableMax,
  );
  const isGapless = entries.every(
    (entry, index) =>
      entry.slotId === buildRepeatableInputSlotId(input, index),
  );
  if (isGapless) {
    return mediaInputs;
  }
  return writeRepeatableSlotValues(
    mediaInputs,
    input,
    inputById,
    repeatableMax,
    entries.map((entry) => entry.value),
  );
}

/**
 * Identity for a timeline selection as far as per-item switches are concerned:
 * the same range over the same clips. Re-preparing a selection rewrites the
 * value with an equal selection, while picking a new range produces a
 * different one and must not inherit the previous item's switches.
 */
function isSameTimelineSelection(
  previous: TimelineSelection,
  next: TimelineSelection,
): boolean {
  if (previous === next) return true;
  if (previous.start !== next.start || previous.end !== next.end) return false;
  if (previous.clips.length !== next.clips.length) return false;
  return previous.clips.every((clip, index) => clip.id === next.clips[index]?.id);
}

/**
 * A batch item's per-item switches belong to the media, not to the slot it
 * happens to occupy. Preparation rewrites a value in place (an extraction
 * finishing, a selection re-rendered), so carry the switches across whenever
 * the replacement is the same media.
 */
function carryForwardItemOptions(
  previous: GenerationMediaInputValue | null,
  next: GenerationMediaInputValue,
): GenerationMediaInputValue {
  if (!previous) return next;

  const carry = (includeEmbeddedAudio: boolean | undefined) =>
    typeof includeEmbeddedAudio === "boolean"
      ? { ...next, includeEmbeddedAudio }
      : next;

  if (
    previous.kind === "asset" &&
    next.kind === "asset" &&
    previous.asset.id === next.asset.id
  ) {
    return carry(previous.includeEmbeddedAudio);
  }
  if (
    previous.kind === "timelineSelection" &&
    previous.mediaType === "video" &&
    next.kind === "timelineSelection" &&
    next.mediaType === "video" &&
    isSameTimelineSelection(previous.timelineSelection, next.timelineSelection)
  ) {
    return carry(previous.includeEmbeddedAudio);
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
  | "setMediaInputFrameWithSelection"
  | "setMediaInputTimelineSelection"
  | "reassignMediaInput"
  | "moveMediaInput"
  | "setMediaInputItemOption"
  | "clearMediaInput"
> {
  return {
    setMediaInputAsset: (inputId, asset: Asset, options) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "asset",
          asset,
          isExtracting: options?.isExtracting ?? false,
          extractionRequestId: options?.extractionRequestId ?? 0,
          extractedAudioFile: options?.extractedAudioFile ?? null,
          extractionError: options?.extractionError ?? null,
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

    moveMediaInput: (sourceInputId, targetIndex) => {
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const workflowInput = resolveWorkflowInputForSlot(sourceInputId, inputById);
      const repeatableMax = workflowInput?.presentation?.repeatable?.max;
      if (!workflowInput || !repeatableMax) return;

      const entries = readRepeatableSlotValues(
        mediaInputs,
        workflowInput,
        inputById,
        repeatableMax,
      );
      // Matched by slot rather than by slot index: the two only agree while the
      // batch is gapless, and the move itself is what closes any gap.
      const sourceSlotId = buildRepeatableInputSlotId(
        workflowInput,
        parseRepeatableInputSlotId(sourceInputId)?.index ?? 0,
      );
      const sourceIndex = entries.findIndex(
        (entry) => entry.slotId === sourceSlotId,
      );
      if (sourceIndex < 0) return;
      const destination = Math.max(
        0,
        Math.min(entries.length - 1, Math.floor(targetIndex)),
      );
      if (destination === sourceIndex) return;

      const reordered = entries.map((entry) => entry.value);
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(destination, 0, moved);
      set({
        mediaInputs: writeRepeatableSlotValues(
          mediaInputs,
          workflowInput,
          inputById,
          repeatableMax,
          reordered,
        ),
      });
    },

    setMediaInputItemOption: (
      inputId: string,
      option: WorkflowInputItemOption,
      active: boolean,
    ) => {
      if (option !== "audio") return;
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const keys = resolveWorkflowInputKeys(inputId, inputById);
      const existingKey = keys.find((key) =>
        Object.prototype.hasOwnProperty.call(mediaInputs, key),
      );
      const value = existingKey ? mediaInputs[existingKey] : null;
      if (!existingKey || !value) return;
      if (value.kind === "frame") return;
      if (value.kind === "timelineSelection" && value.mediaType !== "video") {
        return;
      }
      set({
        mediaInputs: {
          ...mediaInputs,
          [existingKey]: { ...value, includeEmbeddedAudio: active },
        },
      });
    },

    clearMediaInput: (inputId) => {
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const workflowInput = resolveWorkflowInputForSlot(inputId, inputById);
      const repeatableMax = workflowInput?.presentation?.repeatable?.max;
      if (workflowInput && repeatableMax) {
        const parsedSlot = parseRepeatableInputSlotId(inputId);
        const clearedIndex = parsedSlot?.index ?? 0;
        const next = { ...mediaInputs };
        const clearedKeys =
          clearedIndex === 0
            ? resolveWorkflowInputKeys(inputId, inputById)
            : [inputId];
        const clearedValue = getExistingMediaInputValue(next, clearedKeys);
        revokePreviewUrl(clearedValue);
        for (const key of clearedKeys) {
          delete next[key];
        }
        for (let index = clearedIndex; index < repeatableMax - 1; index += 1) {
          const currentSlotId = buildRepeatableInputSlotId(workflowInput, index);
          const nextSlotId = buildRepeatableInputSlotId(workflowInput, index + 1);
          if (Object.prototype.hasOwnProperty.call(next, nextSlotId)) {
            next[currentSlotId] = next[nextSlotId] ?? null;
          } else {
            delete next[currentSlotId];
          }
        }
        delete next[
          buildRepeatableInputSlotId(workflowInput, repeatableMax - 1)
        ];
        set({ mediaInputs: next });
        return;
      }
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
  const previous = getExistingMediaInputValue(mediaInputs, inputKeys);
  return {
    ...removeMediaInputEntries(mediaInputs, inputKeys),
    [canonicalInputId]: carryForwardItemOptions(previous, value),
  };
}

function reassignMediaInputs(
  get: GenerationStoreGet,
  sourceInputId: string,
  targetInputId: string,
): Record<string, GenerationMediaInputValue | null> {
  const { workflowInputs, mediaInputs } = get();
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const sourceInput = resolveWorkflowInputForSlot(sourceInputId, inputById);
  const targetInput = resolveWorkflowInputForSlot(targetInputId, inputById);

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

  // Moving a value into an empty slot of another input empties the one it came
  // from, which can leave a batch with a hole in the middle.
  return compactRepeatableInput(
    compactRepeatableInput(next, sourceInput, inputById),
    targetInput,
    inputById,
  );
}
