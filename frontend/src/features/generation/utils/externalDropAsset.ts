import type { Asset } from "../../../types/Asset";
import { mediaProcessingService } from "../../userAssets/services/MediaProcessingService";

interface ResolveExistingAssetForExternalDropDeps {
  computeChecksum?: (file: File) => Promise<string>;
  sanitizeFilename?: (name: string) => string;
}

export async function resolveExistingAssetForExternalDrop(
  file: File,
  assets: readonly Asset[],
  deps: ResolveExistingAssetForExternalDropDeps = {},
): Promise<Asset | null> {
  const sanitizeFilename =
    deps.sanitizeFilename ??
    ((name: string) => mediaProcessingService.sanitizeFilename(name));
  const safeName = sanitizeFilename(file.name);
  const matchingByName = assets.find((asset) => asset.name === safeName);
  if (matchingByName) {
    return matchingByName;
  }

  const computeChecksum =
    deps.computeChecksum ??
    ((candidateFile: File) => mediaProcessingService.computeChecksum(candidateFile));
  const hash = await computeChecksum(file);
  return assets.find((asset) => asset.hash === hash) ?? null;
}
