import {
  extractAudioFromSelection,
  extractAudioFromVideo,
} from "../../utils/manualSlotMedia";
import {
  applySelectionConfigDefaults,
  resolveExportFps,
} from "./selectionHelpers";
import type { Processor, FrontendPreprocessContext } from "../types";
import { throwIfAborted } from "../utils/abort";

/**
 * Extracts audio from video sources for manual slots with `slotInputType === "audio"`.
 *
 * Supports extraction from:
 * - Video selections (via timeline rendering then audio extraction)
 * - Prepared video files (direct audio extraction)
 * - Raw video file uploads (direct audio extraction)
 */
export const extractSlotAudio: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "extractSlotAudio",
    reads: ["slotValues", "workflowInputs", "projectConfig"],
    writes: ["manualSlotAudioInputs"],
    description:
      "Extracts audio from video sources for manual audio slot inputs",
  },

  isActive(ctx) {
    const inputByNodeId = new Map(
      ctx.workflowInputs.map((input) => [input.nodeId, input]),
    );
    for (const [nodeId] of Object.entries(ctx.slotValues)) {
      const input = inputByNodeId.get(nodeId);
      const dispatch = input?.dispatch;
      if (
        dispatch?.kind === "manual_slot" &&
        dispatch.slotInputType === "audio"
      ) {
        return true;
      }
    }
    return false;
  },

  async execute(ctx) {
    throwIfAborted(ctx.signal);
    const inputByNodeId = new Map(
      ctx.workflowInputs.map((input) => [input.nodeId, input]),
    );
    const projectFps = Math.max(1, ctx.projectConfig.fps);

    for (const [nodeId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputByNodeId.get(nodeId);
      const dispatch = input?.dispatch;
      if (dispatch?.kind !== "manual_slot") continue;
      if (dispatch.slotInputType !== "audio") continue;

      const { slotId, selectionConfig } = dispatch;

      const audioFile =
        value.type === "video_selection"
          ? value.preparedVideoFile
            ? await extractAudioFromVideo(value.preparedVideoFile, {
                signal: ctx.signal,
              })
            : await extractAudioFromSelection(
                applySelectionConfigDefaults(value.selection, selectionConfig),
                {
                  exportFps: resolveExportFps(
                    value.selection,
                    selectionConfig,
                    projectFps,
                  ),
                  signal: ctx.signal,
                },
              )
          : value.type === "video"
            ? await extractAudioFromVideo(value.file, {
                signal: ctx.signal,
              })
            : null;

      throwIfAborted(ctx.signal);
      if (!audioFile) {
        throw new Error(
          `Slot '${slotId}' could not extract audio from source`,
        );
      }
      ctx.manualSlotAudioInputs[slotId] = audioFile;
    }
  },
};
