/**
 * Pure file-naming utilities for the generation pipeline.
 */

export function fileExtension(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : "";
}

export function stripExtension(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx >= 0 ? name.slice(0, dotIdx) : name;
}

export function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/bmp") return ".bmp";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/mp4") return ".mp4";
  return "";
}

export function renameWithExtension(name: string, extension: string): string {
  if (!extension) return name;
  const base = stripExtension(name);
  return `${base}${extension}`;
}

export function extractTrailingNumber(name: string): number | null {
  const match = name.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortFrameFilesBySequence(frameFiles: File[]): File[] {
  return [...frameFiles].sort((left, right) => {
    const leftIndex = extractTrailingNumber(left.name);
    const rightIndex = extractTrailingNumber(right.name);
    if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== null && rightIndex === null) return -1;
    if (leftIndex === null && rightIndex !== null) return 1;
    return left.name.localeCompare(right.name);
  });
}
