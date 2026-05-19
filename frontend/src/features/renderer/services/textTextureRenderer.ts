import { Text } from "pixi.js";
import type { Renderer, Texture } from "pixi.js";
import type {
  TextClipData,
  TextTimelineClip,
} from "../../../types/TimelineTypes";
import { livePreviewTextStore } from "../../text/services/livePreviewTextStore";
import { resolveTextClipData } from "../../text/utils/textClipData";

const MIN_TEXT_RENDER_RESOLUTION = 1;
const MAX_TEXT_RENDER_RESOLUTION = 8;

export function getEffectiveTextClipData(clip: TextTimelineClip): TextClipData {
  const previewTextData = livePreviewTextStore.get(clip.id);
  return resolveTextClipData({
    ...clip.textData,
    ...previewTextData,
  });
}

export function getTextRenderResolution(
  renderer: Renderer | null,
  logicalDimensions: { width: number; height: number },
): number {
  if (!renderer) {
    return MIN_TEXT_RENDER_RESOLUTION;
  }

  const widthRatio = renderer.width / Math.max(1, logicalDimensions.width);
  const heightRatio = renderer.height / Math.max(1, logicalDimensions.height);

  return Math.max(
    MIN_TEXT_RENDER_RESOLUTION,
    Math.min(
      MAX_TEXT_RENDER_RESOLUTION,
      Math.max(widthRatio, heightRatio),
    ),
  );
}

export function getTextTextureSignature(
  clip: TextTimelineClip,
  renderer: Renderer | null,
  logicalDimensions: { width: number; height: number },
): string {
  const textData = getEffectiveTextClipData(clip);
  const renderResolution = getTextRenderResolution(renderer, logicalDimensions);

  return JSON.stringify({
    content: textData.content,
    fontFamily: textData.fontFamily,
    fontSize: textData.fontSize,
    fill: textData.fill,
    align: textData.align,
    strokeColor: textData.strokeColor,
    strokeWidth: textData.strokeWidth,
    logicalWidth: logicalDimensions.width,
    logicalHeight: logicalDimensions.height,
    renderResolution,
  });
}

export function createTextTexture(
  clip: TextTimelineClip,
  renderer: Renderer | null,
  logicalDimensions: { width: number; height: number },
): Texture | null {
  if (!renderer) {
    return null;
  }

  const textData = getEffectiveTextClipData(clip);
  const renderResolution = getTextRenderResolution(renderer, logicalDimensions);
  const text = new Text({
    text: textData.content.length > 0 ? textData.content : " ",
    resolution: renderResolution,
    style: {
      align: textData.align,
      fill: textData.fill,
      fontFamily: textData.fontFamily,
      fontSize: textData.fontSize,
      whiteSpace: "pre-line",
      ...(textData.strokeWidth > 0
        ? {
            stroke: {
              color: textData.strokeColor,
              width: textData.strokeWidth,
              join: "round",
            },
          }
        : {}),
    },
  });

  try {
    return renderer.generateTexture({
      target: text,
      resolution: renderResolution,
      clearColor: [0, 0, 0, 0],
    });
  } finally {
    text.destroy();
  }
}
