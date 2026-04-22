import type { Asset } from "../../../types/Asset";
import { mediaProcessingService } from "../../userAssets/services/MediaProcessingService";

interface ResolveExistingAssetForExternalDropDeps {
  computeChecksum?: (file: File) => Promise<string>;
}

export async function resolveExistingAssetForExternalDrop(
  file: File,
  assets: readonly Asset[],
  deps: ResolveExistingAssetForExternalDropDeps = {},
): Promise<Asset | null> {
  const computeChecksum =
    deps.computeChecksum ??
    ((candidateFile: File) => mediaProcessingService.computeChecksum(candidateFile));
  const hash = await computeChecksum(file);
  return assets.find((asset) => asset.hash === hash) ?? null;
}
