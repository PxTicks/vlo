import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import { maybeResizeVisualFile, resolveResizeTarget } from "../utils/media";
import type { FrontendPostprocessContext, Processor } from "../types";

/**
 * Applies configured exact-dimension visual resizing after generation so
 * imported assets match the requested output aspect ratio.
 */
export const aspectRatioResize: Processor<FrontendPostprocessContext> = {
  meta: {
    name: "aspectRatioResize",
    reads: [
      "fetchedFiles",
      "packagedVideo",
      "aspectRatioProcessing",
      "preparedMaskFile",
    ],
    writes: [
      "fetchedFiles",
      "frameFiles",
      "audioFiles",
      "videoFiles",
      "packagedVideo",
      "preparedMaskFile",
    ],
    description:
      "Resizes generated visual outputs to the configured exact aspect-ratio target when enabled",
  },

  isActive(ctx) {
    return resolveResizeTarget(ctx.aspectRatioProcessing) !== null;
  },

  async execute(ctx) {
    const resizeTarget = resolveResizeTarget(ctx.aspectRatioProcessing);
    if (!resizeTarget) return;

    for (const entry of ctx.fetchedFiles) {
      entry.file = await maybeResizeVisualFile(entry.file, resizeTarget);
    }

    ctx.frameFiles = ctx.fetchedFiles
      .map(({ file }) => file)
      .filter((file) => getOutputMediaKindFromFile(file) === "image");
    ctx.audioFiles = ctx.fetchedFiles
      .map(({ file }) => file)
      .filter((file) => getOutputMediaKindFromFile(file) === "audio");
    ctx.videoFiles = ctx.fetchedFiles
      .map(({ file }) => file)
      .filter((file) => getOutputMediaKindFromFile(file) === "video");

    if (ctx.packagedVideo) {
      ctx.packagedVideo = await maybeResizeVisualFile(
        ctx.packagedVideo,
        resizeTarget,
      );
    }

    if (ctx.preparedMaskFile) {
      ctx.preparedMaskFile = await maybeResizeVisualFile(
        ctx.preparedMaskFile,
        resizeTarget,
      );
    }
  },
};
