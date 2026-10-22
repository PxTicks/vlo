import { getAspectRatioStage } from "../../services/workflowRules";
import type { WorkflowInput } from "../../types";
import {
  buildWorkflowInputLookup,
  getRepeatableRequestKeyIndex,
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
interface AnchorFile {
  kind: "image" | "video";
  requestKey: string;
  file: File;
}

/**
 * The file that frames the output when the stage declares an anchor input:
 * the anchor's own file, or the first item of a repeatable anchor. `null`
 * when no anchor is declared; `undefined` when one is declared but empty.
 */
function resolveAnchorFile(
  ctx: FrontendPreprocessContext,
): AnchorFile | null | undefined {
  const anchorNodeId =
    getAspectRatioStage(ctx.workflowRules)?.config?.anchor_input ?? null;
  if (!anchorNodeId) return null;

  const inputById = buildWorkflowInputLookup(ctx.workflowInputs);
  let best: (AnchorFile & { index: number }) | undefined;
  for (const input of ctx.workflowInputs) {
    if (input.nodeId !== anchorNodeId) continue;
    if (input.inputType !== "image" && input.inputType !== "video") continue;
    const files = input.inputType === "image" ? ctx.imageInputs : ctx.videoInputs;
    for (const [requestKey, file] of Object.entries(files)) {
      if (!matchesNodeInputRequestKey(requestKey, input, inputById)) continue;
      const index = getRepeatableRequestKeyIndex(requestKey) ?? 0;
      if (!best || index < best.index) {
        best = { kind: input.inputType, requestKey, file, index };
      }
    }
  }
  return best
    ? { kind: best.kind, requestKey: best.requestKey, file: best.file }
    : undefined;
}

async function probeAnchorAspectRatio(anchor: AnchorFile): Promise<string | null> {
  try {
    return await probeVisualFileAspectRatio(anchor.file);
  } catch (error) {
    console.warn(
      "[Generation] Failed to probe anchor aspect ratio",
      anchor.requestKey,
      error,
    );
    return null;
  }
}

async function resolveRequestedTargetAspectRatio(
  ctx: FrontendPreprocessContext,
  anchor: AnchorFile | null | undefined,
): Promise<string> {
  if (ctx.requestedAspectRatio) {
    return ctx.requestedAspectRatio;
  }

  // A declared anchor alone frames the output; the other inputs are
  // references whose shapes say nothing about the frame.
  if (anchor !== null) {
    const anchorAspectRatio = anchor ? await probeAnchorAspectRatio(anchor) : null;
    return anchorAspectRatio ?? ctx.projectConfig.aspectRatio;
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
      "workflowRules",
      "workflowInputs",
      "derivedMaskMappings",
      "projectConfig",
      "exactAspectRatio",
      "requestedAspectRatio",
      "slotValues",
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
    const anchor = resolveAnchorFile(ctx);
    const requestedTargetAspectRatio =
      await resolveRequestedTargetAspectRatio(ctx, anchor);
    // A captured custom canvas remains supported after the project changes,
    // just as the live project's custom ratio is supported for fresh inputs.
    const capturedAspectRatios = Object.values(ctx.slotValues).flatMap((value) => {
      const ratio = value.type === "video_selection"
        ? value.selection.aspectRatio
        : value.type === "image" ? value.canvasAspectRatio : undefined;
      return ratio ? [ratio] : [];
    });
    const targetAspectRatio = ctx.exactAspectRatio
      ? requestedTargetAspectRatio
      : normalizeToSupportedProjectAspectRatio(requestedTargetAspectRatio, [
          ctx.projectConfig.aspectRatio,
          ...capturedAspectRatios,
        ]) ?? requestedTargetAspectRatio;

    ctx.targetAspectRatio = targetAspectRatio;

    if (ctx.exactAspectRatio) {
      return;
    }

    if (anchor !== null) {
      // Fit only the framing item; cropping the references would cut away
      // the very detail they were supplied for.
      if (!anchor) return;
      const cropped = await maybeCropVisualFileToAspectRatio(
        anchor.file,
        targetAspectRatio,
      );
      if (anchor.kind === "image") {
        ctx.imageInputs = { ...ctx.imageInputs, [anchor.requestKey]: cropped };
      } else {
        ctx.videoInputs = { ...ctx.videoInputs, [anchor.requestKey]: cropped };
      }
      return;
    }

    const croppedInputs = await buildCroppedVisualInputs(ctx, targetAspectRatio);
    ctx.imageInputs = croppedInputs.imageInputs;
    ctx.videoInputs = croppedInputs.videoInputs;
  },
};
