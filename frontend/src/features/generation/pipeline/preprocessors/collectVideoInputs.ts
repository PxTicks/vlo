import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowSelectionConfig } from "../../types";
import { DEFAULT_DERIVED_MASK_SOURCE_VIDEO_TREATMENT } from "../../derivedMaskVideoTreatment";
import {
  renderTimelineSelectionToWebm,
  renderTimelineSelectionToWebmWithMask,
} from "../../utils/inputSelection";
import {
  buildWorkflowInputLookup,
  getNodeInputRequestKey,
} from "../../utils/workflowInputs";
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
    writes: ["videoInputs"],
    description:
      "Normalizes video selections into WebM files, renders derived masks, and routes video inputs",
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
      config?: WorkflowSelectionConfig,
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

    for (const [inputId, value] of Object.entries(ctx.slotValues)) {
      throwIfAborted(ctx.signal);
      const input = inputById.get(inputId);
      const dispatch = input?.dispatch;

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
            ctx.videoInputs[maskRequestKey] = result.mask;
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
