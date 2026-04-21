import * as comfyApi from "../../services/comfyuiApi";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import type { FrontendPostprocessContext, Processor } from "../types";

/**
 * Fetches every generated output file from ComfyUI and indexes them by media kind
 * for later postprocessing steps.
 */
export const fetchOutputs: Processor<FrontendPostprocessContext> = {
  meta: {
    name: "fetchOutputs",
    reads: ["outputs"],
    writes: ["fetchedFiles", "frameFiles", "audioFiles", "videoFiles"],
    description:
      "Fetches generated output files and groups them into frame, audio, and video collections",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    ctx.fetchedFiles = [];
    ctx.frameFiles = [];
    ctx.audioFiles = [];
    ctx.videoFiles = [];

    for (const output of ctx.outputs) {
      const file = await comfyApi.fetchOutputAsFile(
        output.filename,
        output.subfolder,
        output.type,
      );

      ctx.fetchedFiles.push({ output, file });

      const mediaKind = getOutputMediaKindFromFile(file);
      if (mediaKind === "image") {
        ctx.frameFiles.push(file);
        continue;
      }
      if (mediaKind === "audio") {
        ctx.audioFiles.push(file);
        continue;
      }
      if (mediaKind === "video") {
        ctx.videoFiles.push(file);
      }
    }
  },
};
