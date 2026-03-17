import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowManualSlotSelectionConfig } from "../../types";
import { DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT } from "../../derivedMaskVideoTreatment";
import {
  renderTimelineSelectionToWebm,
  renderTimelineSelectionToWebmWithMask,
} from "../../utils/inputSelection";
import { prepareNormalizedSelection } from "./selectionHelpers";
import { throwIfAborted } from "../utils/abort";
import type {
  DerivedMaskMapping,
  DerivedMaskType,
  FrontendPreprocessContext,
  Processor,
} from "../types";

/**
 * Collects video and video_selection slot values, normalizes timeline
 * selections into WebM files, and renders derived masks alongside
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
    writes: ["videoInputs", "manualSlotVideoInputs"],
    description:
      "Normalizes video selections into WebM files, renders derived masks, and routes video inputs",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    const inputByNodeId = new Map(
      ctx.workflowInputs.map((input) => [input.nodeId, input]),
    );
    const projectFps = Math.max(1, ctx.projectConfig.fps);

    // Build lookup: sourceNodeId → mask mappings
    const masksBySource = new Map<string, DerivedMaskMapping[]>();
    for (const mapping of ctx.derivedMaskMappings) {
      const existing = masksBySource.get(mapping.sourceNodeId) ?? [];
      existing.push(mapping);
      masksBySource.set(mapping.sourceNodeId, existing);
    }

    async function normalizeVideoSelection(
      selection: TimelineSelection,
      preparedVideoFile?: File,
      config?: WorkflowManualSlotSelectionConfig,
    ): Promise<File> {
      if (preparedVideoFile) return preparedVideoFile;
      throwIfAborted(ctx.signal);
      return renderTimelineSelectionToWebm(
        prepareNormalizedSelection(selection, projectFps, config),
        { signal: ctx.signal },
      );
    }

    async function normalizeVideoSelectionWithMask(
      selection: TimelineSelection,
      maskType: DerivedMaskType,
      videoTreatment = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
      preparedVideoFile?: File,
      preparedMaskFile?: File,
      preparedVideoTreatment = DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
      config?: WorkflowManualSlotSelectionConfig,
    ): Promise<{ video: File; mask: File }> {
      if (
        preparedVideoFile &&
        preparedMaskFile &&
        preparedVideoTreatment === videoTreatment
      ) {
        return { video: preparedVideoFile, mask: preparedMaskFile };
      }
      throwIfAborted(ctx.signal);
      return renderTimelineSelectionToWebmWithMask(
        prepareNormalizedSelection(selection, projectFps, config),
        maskType,
        {
          signal: ctx.signal,
          videoTreatment,
        },
      );
    }

    for (const [nodeId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputByNodeId.get(nodeId);
      const dispatch = input?.dispatch;

      if (dispatch?.kind === "manual_slot") {
        const { slotId, slotInputType, selectionConfig } = dispatch;
        if (slotInputType !== "video") continue;

        if (value.type === "video_selection") {
          ctx.manualSlotVideoInputs[slotId] =
            await normalizeVideoSelection(
              value.selection,
              value.preparedVideoFile,
              selectionConfig,
            );
          throwIfAborted(ctx.signal);
          continue;
        }
        if (value.type === "video") {
          ctx.manualSlotVideoInputs[slotId] = value.file;
          continue;
        }
        throw new Error(`Slot '${slotId}' expects a video input`);
      }

      if (value.type !== "video" && value.type !== "video_selection") {
        continue;
      }

      if (value.type === "video") {
        ctx.videoInputs[nodeId] = value.file;
      } else if (value.type === "video_selection") {
        const masks = masksBySource.get(nodeId);
        if (masks && masks.length > 0) {
          const videoTreatment =
            value.derivedMaskVideoTreatment ??
            DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT;
          const result = await normalizeVideoSelectionWithMask(
            value.selection,
            masks[0].maskType,
            videoTreatment,
            value.preparedVideoFile,
            value.preparedMaskFile,
            value.preparedDerivedMaskVideoTreatment ??
              DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT,
          );
          throwIfAborted(ctx.signal);
          ctx.videoInputs[nodeId] = result.video;
          for (const mask of masks) {
            ctx.videoInputs[mask.maskNodeId] = result.mask;
          }
        } else {
          ctx.videoInputs[nodeId] = await normalizeVideoSelection(
            value.selection,
            value.preparedVideoFile,
          );
          throwIfAborted(ctx.signal);
        }
      }
    }
  },
};
