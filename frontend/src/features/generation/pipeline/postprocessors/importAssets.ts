import type { CreationMetadata } from "../../../../types/Asset";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import type { FrontendPostprocessContext, Processor } from "../types";

/**
 * If a prepared mask file exists, ingest it as a separate asset first and
 * link it to the generation metadata so all subsequently ingested output
 * assets carry the `generationMaskAssetId` reference.
 */
async function ingestMaskAsset(
  ctx: FrontendPostprocessContext,
  addLocalAsset: (
    file: File,
    creationMetadata?: CreationMetadata,
  ) => Promise<{ id: string } | null>,
): Promise<void> {
  if (!ctx.preparedMaskFile) return;

  const maskMeta: CreationMetadata = {
    source: "generation_mask",
    parentGeneratedAssetId: "", // will be a forward reference; unused for lookup
  };

  const maskAsset = await addLocalAsset(ctx.preparedMaskFile, maskMeta);
  if (maskAsset) {
    ctx.generationMetadata = {
      ...ctx.generationMetadata,
      generationMaskAssetId: maskAsset.id,
    };
  }
}

/**
 * Imports either the packaged stitched video or the fetched raw outputs into
 * the asset library, and optionally exposes a replacement preview.
 */
export const importAssets: Processor<FrontendPostprocessContext> = {
  meta: {
    name: "importAssets",
    reads: [
      "fetchedFiles",
      "packagedVideo",
      "stitchFailure",
      "stitchMessage",
      "generationMetadata",
      "postprocessingConfig",
      "previewFrameFiles",
      "preparedMaskFile",
    ],
    writes: ["importedAssetIds", "postprocessedPreview", "generationMetadata"],
    description:
      "Imports packaged or raw outputs into the asset library and prepares any replacement preview",
  },

  isActive() {
    return true;
  },

  async execute(ctx) {
    ctx.importedAssetIds = [];
    ctx.postprocessedPreview = null;

    if (
      ctx.stitchFailure &&
      ctx.postprocessingConfig.on_failure === "show_error"
    ) {
      return;
    }

    const { addLocalAsset } = await import("../../../userAssets");

    // This transport is intentionally singular for now: one generation run
    // only ever yields one linked generation mask clip. If we later support
    // multiple generated masks per run, this shared metadata flow must become
    // per-output instead.
    await ingestMaskAsset(ctx, addLocalAsset);

    if (ctx.packagedVideo) {
      const packagedAsset = await addLocalAsset(
        ctx.packagedVideo,
        ctx.generationMetadata,
      );

      if (packagedAsset) {
        ctx.importedAssetIds = [packagedAsset.id];
      }

      const packagedKind = getOutputMediaKindFromFile(ctx.packagedVideo);
      if (
        ctx.postprocessingConfig.panel_preview === "replace_outputs" &&
        packagedKind !== "unknown"
      ) {
        ctx.postprocessedPreview = {
          previewUrl: URL.createObjectURL(ctx.packagedVideo),
          mediaKind: packagedKind,
          filename: ctx.packagedVideo.name,
        };
      }
      return;
    }

    for (const { file } of ctx.fetchedFiles) {
      const asset = await addLocalAsset(file, ctx.generationMetadata);
      if (asset) {
        ctx.importedAssetIds.push(asset.id);
      }
    }

    if (ctx.stitchMessage) {
      const fallbackFrame =
        ctx.fetchedFiles
          .map(({ file }) => file)
          .find((file) => getOutputMediaKindFromFile(file) === "image") ??
        ctx.previewFrameFiles.find(
          (file) => getOutputMediaKindFromFile(file) === "image",
        );

      if (fallbackFrame && ctx.importedAssetIds.length === 0) {
        const fallbackAsset = await addLocalAsset(
          fallbackFrame,
          ctx.generationMetadata,
        );
        if (fallbackAsset) {
          ctx.importedAssetIds.push(fallbackAsset.id);
        }
      }

      if (
        fallbackFrame &&
        ctx.postprocessingConfig.panel_preview === "replace_outputs"
      ) {
        ctx.postprocessedPreview = {
          previewUrl: URL.createObjectURL(fallbackFrame),
          mediaKind: "image",
          filename: fallbackFrame.name,
        };
      }
    }
  },
};
