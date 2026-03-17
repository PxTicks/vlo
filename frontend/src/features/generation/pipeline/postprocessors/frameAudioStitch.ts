import type { GeneratedCreationMetadata } from "../../../../types/Asset";
import { useProjectStore } from "../../../project";
import {
  extractAudioFromSelection,
  extractAudioFromVideo,
} from "../../utils/manualSlotMedia";
import { resolvePostprocessStitchFps, resolveSelectionMetadataFps } from "../utils/fps";
import { packageFramesAndAudioToVideo } from "../utils/videoPackaging";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import type { FrontendPostprocessContext, Processor } from "../types";

async function deriveFallbackAudioFromGenerationMetadata(
  metadata: GeneratedCreationMetadata,
): Promise<File | null> {
  const { getAssetById } = await import("../../../userAssets");
  const projectFps = Math.max(1, useProjectStore.getState().config.fps);

  for (const input of metadata.inputs) {
    if (input.kind === "timelineSelection") {
      try {
        const extracted = await extractAudioFromSelection(
          input.timelineSelection,
          {
            exportFps: resolveSelectionMetadataFps(
              input.timelineSelection,
              projectFps,
            ),
          },
        );
        if (extracted) return extracted;
      } catch {
        // Try the next provenance source.
      }
      continue;
    }

    const parent = getAssetById(input.parentAssetId);
    if (parent?.type !== "video" || !parent.file) continue;
    try {
      const extracted = await extractAudioFromVideo(parent.file);
      if (extracted) return extracted;
    } catch {
      // Try the next provenance source.
    }
  }

  return null;
}

/**
 * Packages frame sequences (optionally with audio) into a single
 * preview/importable video when postprocessing asks for it.
 */
export const frameAudioStitch: Processor<FrontendPostprocessContext> = {
  meta: {
    name: "frameAudioStitch",
    reads: [
      "frameFiles",
      "audioFiles",
      "videoFiles",
      "postprocessingConfig",
      "generationMetadata",
      "previewFrameFiles",
    ],
    writes: ["packagedVideo", "stitchFailure", "stitchMessage"],
    description:
      "Stitches frame outputs (optionally with audio) into a packaged video when postprocessing is configured to do so",
  },

  isActive(ctx) {
    if (ctx.postprocessingConfig.mode === "stitch_frames_with_audio") {
      return true;
    }
    const previewFrameCount = ctx.previewFrameFiles.filter(
      (file) => getOutputMediaKindFromFile(file) === "image",
    ).length;
    return (
      ctx.postprocessingConfig.mode === "auto" &&
      (ctx.frameFiles.length > 1 || previewFrameCount > 1) &&
      ctx.videoFiles.length === 0
    );
  },

  async execute(ctx) {
    ctx.packagedVideo = null;
    ctx.stitchFailure = null;
    ctx.stitchMessage = null;

    const previewFrameFiles = ctx.previewFrameFiles.filter(
      (file) => getOutputMediaKindFromFile(file) === "image",
    );
    const stitchFrameFiles =
      ctx.frameFiles.length > 1
        ? ctx.frameFiles
        : previewFrameFiles.length > 1
          ? previewFrameFiles
          : ctx.frameFiles;

    let stitchAudioFile: File | null = ctx.audioFiles[0] ?? null;
    if (!stitchAudioFile) {
      stitchAudioFile = await deriveFallbackAudioFromGenerationMetadata(
        ctx.generationMetadata,
      );
    }

    if (stitchFrameFiles.length <= 1) {
      ctx.stitchMessage =
        "Only one frame was generated; returning the PNG output.";
      return;
    }

    try {
      const stitchFps = await resolvePostprocessStitchFps(
        ctx.generationMetadata,
        ctx.postprocessingConfig,
      );
      ctx.packagedVideo = await packageFramesAndAudioToVideo(
        stitchFrameFiles,
        stitchAudioFile,
        stitchFps,
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown packaging error";
      ctx.stitchFailure = `Postprocessing failed while stitching frames+audio: ${detail}`;
      console.warn(
        "[Generation] Failed to package frames+audio into video",
        error,
      );
    }
  },
};
