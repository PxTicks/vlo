import type { WorkflowInput } from "../../types";
import {
  buildWorkflowInputLookup,
  matchesNodeInputRequestKey,
} from "../../utils/workflowInputs";
import type { FrontendPreprocessContext, Processor } from "../types";
import { throwIfAborted } from "../utils/abort";
import {
  maybeCropVisualFileToAspectRatio,
  normalizeToSupportedProjectAspectRatio,
  probeVisualFileAspectRatio,
} from "../utils/media";

/**
 * The aspect ratio this dispatch should target.
 *
 * A pinned selection wins outright; only "Auto" probes the supplied media,
 * falling back to the project ratio when nothing can be probed.
 */
async function resolveRequestedTargetAspectRatio(
  ctx: FrontendPreprocessContext,
): Promise<string> {
  if (ctx.requestedAspectRatio) {
    return ctx.requestedAspectRatio;
  }

  const inputById = buildWorkflowInputLookup(ctx.workflowInputs);
  const maskNodeIds = new Set(
    ctx.derivedMaskMappings.map((mapping) => mapping.maskNodeId),
  );

  const resolveInputFile = (input: WorkflowInput): File | undefined => {
    const candidates =
      input.inputType === "image"
        ? ctx.imageInputs
        : input.inputType === "video"
          ? ctx.videoInputs
          : null;
    if (!candidates) return undefined;
    return Object.entries(candidates).find(([requestKey]) =>
      matchesNodeInputRequestKey(requestKey, input, inputById),
    )?.[1];
  };

  const probeInputs = async (
    inputs: readonly WorkflowInput[],
  ): Promise<string | null> => {
    for (const input of inputs) {
      if (input.inputType !== "image" && input.inputType !== "video") {
        continue;
      }
      const file = resolveInputFile(input);
      if (!file) continue;

      try {
        const aspectRatio = await probeVisualFileAspectRatio(file);
        if (aspectRatio) return aspectRatio;
      } catch (error) {
        console.warn(
          "[Generation] Failed to probe input aspect ratio",
          input.nodeId,
          error,
        );
      }
    }

    return null;
  };

  const preferredInputs = ctx.workflowInputs.filter(
    (input) => !maskNodeIds.has(input.nodeId),
  );
  const preferredAspectRatio = await probeInputs(preferredInputs);
  if (preferredAspectRatio) {
    return preferredAspectRatio;
  }

  const fallbackAspectRatio = await probeInputs(ctx.workflowInputs);
  return fallbackAspectRatio ?? ctx.projectConfig.aspectRatio;
}

async function buildCroppedVisualInputs(
  ctx: FrontendPreprocessContext,
  targetAspectRatio: string,
): Promise<Pick<FrontendPreprocessContext, "imageInputs" | "videoInputs">> {
  const croppedFiles = new Map<File, Promise<File>>();

  const cropFile = (file: File): Promise<File> => {
    const pending = croppedFiles.get(file);
    if (pending) {
      return pending;
    }

    const nextPending = maybeCropVisualFileToAspectRatio(file, targetAspectRatio);
    croppedFiles.set(file, nextPending);
    return nextPending;
  };

  const imageInputs: Record<string, File> = {};
  for (const [key, file] of Object.entries(ctx.imageInputs)) {
    throwIfAborted(ctx.signal);
    imageInputs[key] = await cropFile(file);
  }

  const videoInputs: Record<string, File> = {};
  for (const [key, file] of Object.entries(ctx.videoInputs)) {
    throwIfAborted(ctx.signal);
    videoInputs[key] = await cropFile(file);
  }

  return { imageInputs, videoInputs };
}

export const prepareAspectRatioInputs: Processor<FrontendPreprocessContext> = {
  meta: {
    name: "prepareAspectRatioInputs",
    reads: [
      "workflowInputs",
      "derivedMaskMappings",
      "projectConfig",
      "exactAspectRatio",
      "requestedAspectRatio",
      "imageInputs",
      "videoInputs",
    ],
    writes: ["targetAspectRatio", "imageInputs", "videoInputs"],
    description:
      "Resolves the dispatch aspect ratio and optionally crops prepared visual inputs to the supported fit",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    const requestedTargetAspectRatio =
      await resolveRequestedTargetAspectRatio(ctx);
    const targetAspectRatio = ctx.exactAspectRatio
      ? requestedTargetAspectRatio
      : normalizeToSupportedProjectAspectRatio(requestedTargetAspectRatio) ??
        requestedTargetAspectRatio;

    ctx.targetAspectRatio = targetAspectRatio;

    if (ctx.exactAspectRatio) {
      return;
    }

    const croppedInputs = await buildCroppedVisualInputs(ctx, targetAspectRatio);
    ctx.imageInputs = croppedInputs.imageInputs;
    ctx.videoInputs = croppedInputs.videoInputs;
  },
};
