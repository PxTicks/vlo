import type { AssetType } from "../../../types/Asset";

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

function getFileAssetType(file: File): AssetType | null {
  const extension = fileExtension(file.name);
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

function getItemAssetType(
  item: Pick<DataTransferItem, "kind" | "type">,
): AssetType | null {
  if (item.kind !== "file") return null;
  if (item.type.startsWith("image/")) return "image";
  if (item.type.startsWith("audio/")) return "audio";
  if (item.type.startsWith("video/")) return "video";
  return null;
}

export function hasDraggedFiles(
  dataTransfer: Pick<DataTransfer, "types"> | null,
): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

export function getExternalFileDragHighlight(
  dataTransfer: Pick<DataTransfer, "types" | "items" | "files"> | null,
  accept: readonly AssetType[],
): "compatible" | "incompatible" | "external" | null {
  if (!hasDraggedFiles(dataTransfer)) {
    return null;
  }

  if (!dataTransfer) {
    return null;
  }

  const items = Array.from(dataTransfer.items ?? []);
  let sawTypedFile = false;
  for (const item of items) {
    const itemType = getItemAssetType(item);
    if (!itemType) continue;
    sawTypedFile = true;
    if (accept.includes(itemType)) {
      return "compatible";
    }
  }
  if (sawTypedFile) {
    return "incompatible";
  }

  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) {
    return getFirstAcceptedFile(files, accept) ? "compatible" : "incompatible";
  }

  return "external";
}

export function getFirstAcceptedFile(
  files: readonly File[],
  accept: readonly AssetType[],
): File | null {
  for (const file of files) {
    const fileType = getFileAssetType(file);
    if (fileType && accept.includes(fileType)) {
      return file;
    }
  }

  return null;
}
