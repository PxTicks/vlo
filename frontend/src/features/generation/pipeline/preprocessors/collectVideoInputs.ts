import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowSelectionConfig } from "../../types";
import {
  renderTimelineSelectionToMp4,
  getDerivedMaskRenderKey,
  renderTimelineSelectionToMp4WithDerivedMasks,
} from "../../utils/inputSelection";
import {
  recordMaskDebugArtifact,
  summarizeSelectionForMaskDebug,
} from "../../utils/maskDebugArtifacts";
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
    const logMaskDebug = (message: string, details: Record<string, unknown>) => {
      console.info(`[Generation][MaskDebug] ${message}`, details);
    };
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

    if (ctx.derivedMaskMappings.length > 0) {
      logMaskDebug("collectVideoInputs derived mask mappings", {
        derivedMaskMappings: ctx.derivedMaskMappings.map((mapping) => ({
          sourceInputId: mapping.sourceInputId ?? null,
          sourceNodeId: mapping.sourceNodeId,
          maskNodeId: mapping.maskNodeId,
          maskParam: mapping.maskParam,
          maskType: mapping.maskType,
          purpose: mapping.purpose ?? "video",
          renderFps: mapping.renderFps ?? null,
          optional: mapping.optional === true,
        })),
      });
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
    ): Promise<Awaited<ReturnType<typeof renderTimelineSelectionToMp4WithDerivedMasks>>> {
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
          maskContentByKey: {
            [visualMaskKey]: true,
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
        const allMasks =
          masksBySource.get(inputId) ?? masksBySource.get(input.nodeId);
        // Optional mask uploads stay compatible with `input_presence`
        // rewrites by withholding the upload after render when the matte is
        // effectively empty.
        const needsRenderedMaskPresenceCheck =
          allMasks?.some((mapping) => mapping.optional) ?? false;
        logMaskDebug("collectVideoInputs processing video selection", {
          inputId,
          sourceNodeId: input.nodeId,
          sourceRequestKey: getNodeInputRequestKey(input, inputById),
          selectionClipIds: value.selection.clips.map((clip) => clip.id),
          maskMappings:
            allMasks?.map((mask) => ({
              key: getDerivedMaskRenderKey(mask),
              sourceNodeId: mask.sourceNodeId,
              maskNodeId: mask.maskNodeId,
              maskParam: mask.maskParam,
              optional: mask.optional === true,
              purpose: mask.purpose ?? "video",
            })) ?? [],
          hasPreparedVideoFile: !!value.preparedVideoFile,
          hasPreparedMaskFile: !!value.preparedMaskFile,
          needsRenderedMaskPresenceCheck,
        });
        if (allMasks && allMasks.length > 0) {
          const result = await normalizeVideoSelectionWithDerivedMasks(
            value.selection,
            allMasks,
            value.preparedVideoFile,
            needsRenderedMaskPresenceCheck ? undefined : value.preparedMaskFile,
          );
          throwIfAborted(ctx.signal);
          ctx.videoInputs[getNodeInputRequestKey(input, inputById)] =
            result.video;
          logMaskDebug("collectVideoInputs rendered selection with masks", {
            inputId,
            sourceNodeId: input.nodeId,
            sourceRequestKey: getNodeInputRequestKey(input, inputById),
            producedMaskKeys: Object.keys(result.masks),
            maskContentByKey: result.maskContentByKey,
            videoFileName: result.video.name,
          });
          for (const mask of allMasks) {
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
            const isPreparedVisualMask = renderedMask === value.preparedMaskFile;
            if (mask.purpose === "audio_timing") {
              recordMaskDebugArtifact({
                category: "submit_rendered_audio_timing_mask",
                file: renderedMask,
                metadata: {
                  workflowId: ctx.workflowId,
                  inputId,
                  sourceNodeId: input.nodeId,
                  maskNodeId: mask.maskNodeId,
                  maskRequestKey,
                  maskRenderKey: getDerivedMaskRenderKey(mask),
                  optional: mask.optional === true,
                  ...summarizeSelectionForMaskDebug(value.selection),
                },
              });
            } else if (isPreparedVisualMask) {
              recordMaskDebugArtifact({
                category: "submit_reused_prepared_visual_mask",
                file: renderedMask,
                metadata: {
                  workflowId: ctx.workflowId,
                  inputId,
                  sourceNodeId: input.nodeId,
                  maskNodeId: mask.maskNodeId,
                  maskRequestKey,
                  maskRenderKey: getDerivedMaskRenderKey(mask),
                  optional: mask.optional === true,
                  reusedPreparedMaskFile: true,
                  ...summarizeSelectionForMaskDebug(value.selection),
                },
              });
            } else if (mask.optional) {
              recordMaskDebugArtifact({
                category: "submit_rendered_optional_visual_mask",
                file: renderedMask,
                metadata: {
                  workflowId: ctx.workflowId,
                  inputId,
                  sourceNodeId: input.nodeId,
                  maskNodeId: mask.maskNodeId,
                  maskRequestKey,
                  maskRenderKey: getDerivedMaskRenderKey(mask),
                  optional: true,
                  hasVisibleContent:
                    result.maskContentByKey[getDerivedMaskRenderKey(mask)] ?? null,
                  ...summarizeSelectionForMaskDebug(value.selection),
                },
              });
            } else {
              recordMaskDebugArtifact({
                category: "submit_rendered_visual_mask",
                file: renderedMask,
                metadata: {
                  workflowId: ctx.workflowId,
                  inputId,
                  sourceNodeId: input.nodeId,
                  maskNodeId: mask.maskNodeId,
                  maskRequestKey,
                  maskRenderKey: getDerivedMaskRenderKey(mask),
                  optional: false,
                  ...summarizeSelectionForMaskDebug(value.selection),
                },
              });
            }
            if (
              mask.optional &&
              result.maskContentByKey[getDerivedMaskRenderKey(mask)] === false
            ) {
              logMaskDebug("collectVideoInputs skipped optional derived mask upload", {
                inputId,
                sourceNodeId: input.nodeId,
                maskNodeId: mask.maskNodeId,
                maskRequestKey,
                maskRenderKey: getDerivedMaskRenderKey(mask),
                reason: "rendered_mask_empty",
              });
              continue;
            }
            ctx.videoInputs[maskRequestKey] = renderedMask;
            logMaskDebug("collectVideoInputs routed derived mask upload", {
              inputId,
              sourceNodeId: input.nodeId,
              maskNodeId: mask.maskNodeId,
              maskRequestKey,
              maskRenderKey: getDerivedMaskRenderKey(mask),
              fileName: renderedMask.name,
              optional: mask.optional === true,
            });
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

    if (Object.keys(ctx.videoInputs).length > 0) {
      logMaskDebug("collectVideoInputs final video input keys", {
        videoInputKeys: Object.keys(ctx.videoInputs),
      });
    }
  },
};
