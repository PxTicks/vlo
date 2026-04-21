import type { AssetFamily, CreationMetadata } from "../../../../types/Asset";
import { isAssetFamilyCompatibilityComplete } from "../../../../shared/utils/assetFamilies";
import { getOutputMediaKindFromFile } from "../../constants/mediaKinds";
import type { FrontendPostprocessContext, Processor } from "../types";
import {
  buildGenerationFamilyAutoMatchKey,
  resolveFamilyForGenerationMatchKey,
} from "../../utils/familyAssignment";

const pendingAutoFamilies = new Map<string, AssetFamily>();

function getRawImportFiles(ctx: FrontendPostprocessContext): File[] {
  const fetchedFiles = ctx.fetchedFiles.map(({ file }) => file);
  if (fetchedFiles.length > 0) {
    return fetchedFiles;
  }

  return ctx.previewFrameFiles.filter(
    (file) => getOutputMediaKindFromFile(file) === "image",
  );
}

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
    familyId?: string,
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

async function ingestGeneratedAsset(
  file: File,
  ctx: FrontendPostprocessContext,
  addLocalAsset: (
    file: File,
    creationMetadata?: CreationMetadata,
    familyId?: string,
  ) => Promise<{ id: string } | null>,
  getFamilies: () => AssetFamily[],
  upsertFamily: (family: AssetFamily) => Promise<void>,
  inspectAssetFamilyCompatibility: (file: File) => Promise<
    import("../../../../types/Asset").AssetFamilyCompatibility | null
  >,
  pendingFamilies: Map<string, AssetFamily>,
): Promise<{ id: string } | null> {
  let family: AssetFamily | undefined;
  let autoMatchKey: string | null = null;
  let compatibility:
    | import("../../../../types/Asset").AssetFamilyCompatibility
    | null = null;

  if (ctx.autoFamilyRequestKey) {
    try {
      compatibility =
        ctx.packagedVideo &&
        file === ctx.packagedVideo &&
        isAssetFamilyCompatibilityComplete(ctx.packagedVideoCompatibility)
          ? ctx.packagedVideoCompatibility
          : await inspectAssetFamilyCompatibility(file);
      autoMatchKey = await buildGenerationFamilyAutoMatchKey(
        ctx.autoFamilyRequestKey,
        compatibility,
      );
      const storeFamilies = getFamilies();
      const knownFamilies = [
        ...storeFamilies,
        ...pendingAutoFamilies.values(),
        ...pendingFamilies.values(),
      ].filter(
        (candidate, index, families) =>
          families.findIndex((familyCandidate) => familyCandidate.id === candidate.id) ===
          index,
      );
      family = resolveFamilyForGenerationMatchKey(
        knownFamilies,
        autoMatchKey,
        compatibility,
      );
      if (family && autoMatchKey) {
        pendingAutoFamilies.set(autoMatchKey, family);
      }
    } catch (error) {
      console.warn(
        "[Generation] Failed to resolve compatible family for generated output",
        error,
      );
    }
  }

  const { addLocalAssetWithFamily } = await import("../../../userAssets");

  const asset =
    family
      ? await addLocalAssetWithFamily(
          file,
          ctx.generationMetadata,
          family,
          compatibility,
        )
      : await addLocalAsset(file, ctx.generationMetadata);

  if (asset && family) {
    const updatedFamily: AssetFamily = {
      ...family,
      representativeAssetId: asset.id,
      updatedAt: Date.now(),
    };
    pendingFamilies.set(updatedFamily.id, updatedFamily);
    await upsertFamily(updatedFamily);
    if (autoMatchKey) {
      pendingAutoFamilies.delete(autoMatchKey);
    }
  } else if (autoMatchKey) {
    pendingAutoFamilies.delete(autoMatchKey);
  }

  return asset;
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
      "autoFamilyRequestKey",
      "postprocessingConfig",
      "previewFrameFiles",
      "preparedMaskFile",
      "packagedVideoCompatibility",
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

    const {
      addLocalAsset,
      getFamilies,
      inspectAssetFamilyCompatibility,
      upsertFamily,
    } = await import("../../../userAssets");
    const pendingFamilies = new Map<string, AssetFamily>();

    // This transport is intentionally singular for now: one generation run
    // only ever yields one linked generation mask clip. If we later support
    // multiple generated masks per run, this shared metadata flow must become
    // per-output instead.
    await ingestMaskAsset(ctx, addLocalAsset);

    if (ctx.packagedVideo) {
      const packagedAsset = await ingestGeneratedAsset(
        ctx.packagedVideo,
        ctx,
        addLocalAsset,
        getFamilies,
        upsertFamily,
        inspectAssetFamilyCompatibility,
        pendingFamilies,
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

    const rawImportFiles = getRawImportFiles(ctx);

    for (const file of rawImportFiles) {
      const asset = await ingestGeneratedAsset(
        file,
        ctx,
        addLocalAsset,
        getFamilies,
        upsertFamily,
        inspectAssetFamilyCompatibility,
        pendingFamilies,
      );
      if (asset) {
        ctx.importedAssetIds.push(asset.id);
      }
    }

    if (ctx.stitchMessage) {
      const fallbackFrame = rawImportFiles.find(
        (file) => getOutputMediaKindFromFile(file) === "image",
      );

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
