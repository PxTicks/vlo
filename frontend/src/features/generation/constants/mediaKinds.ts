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
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv"]);

export type OutputMediaKind = "image" | "video" | "audio" | "unknown";

function fileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

export function getOutputMediaKindFromFile(file: File): OutputMediaKind {
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(file.name))) {
    return "image";
  }
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(fileExtension(file.name))) {
    return "audio";
  }
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(fileExtension(file.name))) {
    return "video";
  }
  return "unknown";
}

export function getOutputMediaKindFromFilename(filename: string): OutputMediaKind {
  const ext = fileExtension(filename);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "unknown";
}
