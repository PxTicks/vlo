import type { Asset, AssetType } from "../../types/Asset";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".gif",
]);
const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv"]);

function fileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function assetTypeFromMimeType(
  mimeType: string | null | undefined,
): AssetType | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

function assetTypeFromFilename(filename: string | null | undefined): AssetType | null {
  if (!filename) return null;
  const extension = fileExtension(filename);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

function assetTypeFromSourceUrl(src: string | null | undefined): AssetType | null {
  if (!src) return null;
  const cleanSrc = src.split("#", 1)[0]?.split("?", 1)[0] ?? src;
  return assetTypeFromFilename(cleanSrc);
}

export function resolveAssetType(
  asset: Pick<Asset, "type" | "file" | "name" | "src">,
): AssetType | null {
  const fileMimeType = assetTypeFromMimeType(asset.file?.type);
  if (fileMimeType) {
    return fileMimeType;
  }

  const fileNameType = assetTypeFromFilename(asset.file?.name);
  if (fileNameType) {
    return fileNameType;
  }

  const assetNameType = assetTypeFromFilename(asset.name);
  if (assetNameType) {
    return assetNameType;
  }

  const assetSrcType = assetTypeFromSourceUrl(asset.src);
  if (assetSrcType) {
    return assetSrcType;
  }

  return asset.type ?? null;
}

export function assetMatchesType(
  asset: Pick<Asset, "type" | "file" | "name" | "src">,
  expectedType: AssetType,
): boolean {
  return resolveAssetType(asset) === expectedType;
}
