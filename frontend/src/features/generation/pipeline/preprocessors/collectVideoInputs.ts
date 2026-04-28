import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowSelectionConfig } from "../../types";
import {
  renderTimelineSelectionToMp4,
  getDerivedMaskRenderKey,
  renderTimelineSelectionToMp4WithDerivedMasks,
} from "../../utils/inputSelection";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../../utils/workflowInputs";
import { prepareNormalizedSelection } from "./selectionHelpers";
import { throwIfAborted } from "../utils/abort";
import type {
  DerivedMaskMapping,
  FrontendPreprocessContext,
  Processor,
} from "../types";

/**
 * Collects video and video_selection slot values, normalizes timeline
 * selections into MP4 files, and renders derived masks alongside
 * their source videos.
 *
 * Handles both direct node video inputs and manual slot video inputs.
 */
export const collectVideoInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "collectVideoInputs",
    reads: [
      "slotValues",
      "workflowInputs",
      "derivedMaskMappings",
      "projectConfig",
    ],
    writes: ["videoInputs"],
    description:
      "Normalizes video selections into MP4 files, renders derived masks, and routes video inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    const inputById = buildWorkflowInputLookup(ctx.workflowInputs);
    const projectFps = Math.max(1, ctx.projectConfig.fps);

    // Build lookup: sourceInputId/sourceNodeId → mask mappings
    const masksBySource = new Map<string, DerivedMaskMapping[]>();
    for (const mapping of ctx.derivedMaskMappings) {
      const keys = new Set<string>([
        mapping.sourceInputId ?? mapping.sourceNodeId,
        mapping.sourceNodeId,
      ]);
      for (const key of keys) {
        const existing = masksBySource.get(key) ?? [];
        existing.push(mapping);
        masksBySource.set(key, existing);
      }
    }

    async function normalizeVideoSelection(
      selection: TimelineSelection,
      preparedVideoFile?: File,
      config?: WorkflowSelectionConfig,
    ): Promise<File> {
      if (preparedVideoFile) return preparedVideoFile;
      throwIfAborted(ctx.signal);
      return renderTimelineSelectionToMp4(
        prepareNormalizedSelection(selection, projectFps, config),
        { signal: ctx.signal },
      );
    }

    async function normalizeVideoSelectionWithDerivedMasks(
      selection: TimelineSelection,
      masks: readonly DerivedMaskMapping[],
      preparedVideoFile?: File,
      preparedMaskFile?: File,
      config?: WorkflowSelectionConfig,
    ) {
      const visualMasks = masks.filter((mask) => mask.purpose !== "audio_timing");
      const hasAudioTimingMasks = visualMasks.length !== masks.length;
      const uniqueVisualMaskKeys = new Set(
        visualMasks.map((mask) => getDerivedMaskRenderKey(mask)),
      );
      if (
        !hasAudioTimingMasks &&
        uniqueVisualMaskKeys.size === 1 &&
        preparedVideoFile &&
        preparedMaskFile
      ) {
        const [visualMaskKey] = [...uniqueVisualMaskKeys];
        return {
          video: preparedVideoFile,
          masks: {
            [visualMaskKey]: preparedMaskFile,
          },
        };
      }
      throwIfAborted(ctx.signal);
      return renderTimelineSelectionToMp4WithDerivedMasks(
        prepareNormalizedSelection(selection, projectFps, config),
        masks,
        {
          signal: ctx.signal,
          preparedVideoFile,
          preparedMaskFile,
        },
      );
    }

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputById.get(inputId);

      if (value.type !== "video" && value.type !== "video_selection") {
        continue;
      }
      if (!input) continue;

      if (value.type === "video") {
        ctx.videoInputs[getNodeInputRequestKey(input, inputById)] = value.file;
      } else if (value.type === "video_selection") {
        const masks =
          masksBySource.get(inputId) ?? masksBySource.get(input.nodeId);
        if (masks && masks.length > 0) {
          const result = await normalizeVideoSelectionWithDerivedMasks(
            value.selection,
            masks,
            value.preparedVideoFile,
            value.preparedMaskFile,
          );
          throwIfAborted(ctx.signal);
          ctx.videoInputs[getNodeInputRequestKey(input, inputById)] =
            result.video;
          for (const mask of masks) {
            const maskInput = ctx.workflowInputs.find(
              (candidate) =>
                candidate.nodeId === mask.maskNodeId &&
                candidate.param === mask.maskParam,
            );
            const maskRequestKey = maskInput
              ? getNodeInputRequestKey(maskInput, inputById)
              : mask.maskNodeId;
            const renderedMask = result.masks[getDerivedMaskRenderKey(mask)];
            if (!renderedMask) {
              throw new Error(
                `Derived mask render '${getDerivedMaskRenderKey(mask)}' was requested but not produced`,
              );
            }
            ctx.videoInputs[maskRequestKey] = renderedMask;
          }
        } else {
          ctx.videoInputs[getNodeInputRequestKey(input, inputById)] =
            await normalizeVideoSelection(
              value.selection,
              value.preparedVideoFile,
            );
          throwIfAborted(ctx.signal);
        }
      }
    }
  },
};
