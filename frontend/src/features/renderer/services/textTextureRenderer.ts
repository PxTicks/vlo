import { HTMLTextStyle, Text } from "pixi.js";
import type { Renderer, Texture } from "pixi.js";
import type {
  TextClipData,
  TextTimelineClip,
} from "../../../types/TimelineTypes";
import { livePreviewTextStore } from "../../text/services/livePreviewTextStore";
import {
  hasRichFormatting,
  resolveTextClipData,
  runsToHtml,
} from "../../text/utils/textClipData";

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
    runs: textData.runs ?? null,
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

function createPlainTextTexture(
  textData: TextClipData,
  renderer: Renderer,
  renderResolution: number,
): Texture {
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
              join: "round" as const,
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

interface HtmlTextCapableRenderer {
  htmlText: {
    getTexturePromise: (options: {
      text: string;
      style: HTMLTextStyle;
      resolution?: number;
    }) => Promise<Texture>;
  };
}

function hasHtmlTextSystem(
  renderer: Renderer,
): renderer is Renderer & HtmlTextCapableRenderer {
  return (
    typeof (renderer as Partial<HtmlTextCapableRenderer>).htmlText
      ?.getTexturePromise === "function"
  );
}

async function createHtmlTextTexture(
  textData: TextClipData,
  renderer: Renderer,
  renderResolution: number,
): Promise<Texture | null> {
  if (!hasHtmlTextSystem(renderer)) {
    console.warn(
      "[textTextureRenderer] renderer.htmlText.getTexturePromise unavailable; skipping rich text render",
    );
    return null;
  }

  const cssOverrides =
    textData.strokeWidth > 0
      ? [
          `-webkit-text-stroke: ${textData.strokeWidth}px ${textData.strokeColor};`,
          `paint-order: stroke fill;`,
        ]
      : [];

  // HTMLText rejects object-form strokes (only color string/number is accepted),
  // so we express stroke width via cssOverrides instead. HTMLTextStyle must be
  // an actual instance — getTexturePromise reads `style.padding` directly off
  // the object and silently produces NaN dimensions for plain objects.
  // lineHeight=fontSize collapses the browser's default ~1.2× leading so the
  // texture height matches canvas Text; a small symmetric padding keeps
  // descenders from clipping at the bottom of the foreignObject box.
  const style = new HTMLTextStyle({
    align: textData.align,
    fill: textData.fill,
    fontFamily: textData.fontFamily,
    fontSize: textData.fontSize,
    lineHeight: textData.fontSize,
    padding: Math.ceil(textData.fontSize * 0.1),
    whiteSpace: "pre-line",
    cssOverrides,
  });

  const html = runsToHtml(textData.runs ?? []);

  try {
    const texture = await renderer.htmlText.getTexturePromise({
      text: html,
      style,
      resolution: renderResolution,
    });
    if (
      !Number.isFinite(texture.width) ||
      !Number.isFinite(texture.height) ||
      texture.width === 0 ||
      texture.height === 0
    ) {
      console.warn(
        "[textTextureRenderer] HTMLText texture has invalid dimensions",
        { width: texture.width, height: texture.height, html },
      );
    }
    return texture;
  } catch (error) {
    console.error("[textTextureRenderer] HTMLText rendering failed", {
      error,
      html,
      style: {
        fill: textData.fill,
        fontFamily: textData.fontFamily,
        fontSize: textData.fontSize,
        cssOverrides,
      },
    });
    return null;
  }
}

export async function createTextTexture(
  clip: TextTimelineClip,
  renderer: Renderer | null,
  logicalDimensions: { width: number; height: number },
): Promise<Texture | null> {
  if (!renderer) {
    return null;
  }

  const textData = getEffectiveTextClipData(clip);
  const renderResolution = getTextRenderResolution(renderer, logicalDimensions);

  if (textData.runs !== undefined && hasRichFormatting(textData.runs)) {
    return createHtmlTextTexture(textData, renderer, renderResolution);
  }

  return createPlainTextTexture(textData, renderer, renderResolution);
}
