import type { ComfyUIPreview } from "../services/ComfyUIWebSocket";
import type { GenerationJob } from "../types";
import type { PreviewAnimation } from "./types";

export function revokeJobPostprocessPreview(
  job: GenerationJob | null | undefined,
) {
  const previewUrl = job?.postprocessedPreview?.previewUrl;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
}

export function revokePreviewAnimation(animation: PreviewAnimation | null): void {
  if (!animation) return;
  for (const url of animation.frameUrls) {
    if (url) URL.revokeObjectURL(url);
  }
}

export function replacePreviewAnimation(
  currentAnimation: PreviewAnimation | null,
  nextAnimation: PreviewAnimation | null,
): PreviewAnimation | null {
  if (currentAnimation === nextAnimation) {
    return nextAnimation;
  }
  revokePreviewAnimation(currentAnimation);
  return nextAnimation;
}

export function getPreviewFrameExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "png";
}

export function getPreviewFrameIndex(
  preview: ComfyUIPreview,
  existingFrames: File[],
): number {
  if (
    typeof preview.frameIndex === "number" &&
    Number.isInteger(preview.frameIndex) &&
    preview.frameIndex >= 0
  ) {
    return preview.frameIndex;
  }
  return existingFrames.length;
}
