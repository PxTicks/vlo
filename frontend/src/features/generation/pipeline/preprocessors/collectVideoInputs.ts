import type { TimelineSelection } from "../../../../types/TimelineTypes";
import type { WorkflowSelectionConfig } from "../../types";
import {
  renderAssetToMaskMp4,
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
        // The source video goes through unchanged. Note: this path does not
        // honor the workflow's sourceVideoTreatment (preserve_transparency,
        // remove_transparency) — that would need extra plumbing, and may not
        // always be doable: removing pre-multiplied alpha can't be done by a
        // flat composite, it requires un-pre-multiplying first.
        ctx.videoInputs[getNodeInputRequestKey(input, inputById)] = value.file;

        // Direct uploads bypass the timeline render, so any derived mask
        // mappings normally wouldn't fire. Pipe the asset through
        // renderAssetToMaskMp4, which synthesises a 1-clip timeline so the
        // alpha-to-matte shader can run against the asset's baked-in
        // transparency.
        const allMasks =
          masksBySource.get(inputId) ?? masksBySource.get(input.nodeId);
        if (allMasks && allMasks.length > 0 && value.assetId) {
          // Dedupe by render key so binary+soft (or any duplicate-keyed
          // mappings) only render once each; the timeline path does the
          // same in renderTimelineSelectionToMp4WithDerivedMasks.
          const visualMasksByKey = new Map<
            ReturnType<typeof getDerivedMaskRenderKey>,
            DerivedMaskMapping[]
          >();
          for (const mapping of allMasks) {
            // audio_timing masks need timeline activity that doesn't exist
            // for a free-standing asset; skip them here.
            if (mapping.purpose === "audio_timing") continue;
            const key = getDerivedMaskRenderKey(mapping);
            const bucket = visualMasksByKey.get(key) ?? [];
            bucket.push(mapping);
            visualMasksByKey.set(key, bucket);
          }

          for (const [key, mappings] of visualMasksByKey) {
            const { file: maskFile, hasVisibleContent } =
              await renderAssetToMaskMp4(value.assetId, {
                maskType: key === "video_soft" ? "soft" : "binary",
                signal: ctx.signal,
              });
            throwIfAborted(ctx.signal);

            for (const mapping of mappings) {
              if (mapping.optional && !hasVisibleContent) continue;
              const maskInput = ctx.workflowInputs.find(
                (candidate) =>
                  candidate.nodeId === mapping.maskNodeId &&
                  candidate.param === mapping.maskParam,
              );
              const maskRequestKey = maskInput
                ? getNodeInputRequestKey(maskInput, inputById)
                : mapping.maskNodeId;
              ctx.videoInputs[maskRequestKey] = maskFile;
            }
          }
        }
      } else if (value.type === "video_selection") {
        const allMasks =
          masksBySource.get(inputId) ?? masksBySource.get(input.nodeId);
        // Optional mask uploads stay compatible with `input_presence`
        // rewrites by withholding the upload after render when the matte is
        // effectively empty.
        const needsRenderedMaskPresenceCheck =
          allMasks?.some((mapping) => mapping.optional) ?? false;
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
            if (
              mask.optional &&
              result.maskContentByKey[getDerivedMaskRenderKey(mask)] === false
            ) {
              continue;
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
