import {
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  Texture,
  type Renderer,
} from "pixi.js";
import type { BrushPaintedBounds } from "../../../types/TimelineTypes";
import { livePreviewParamStore } from "../../transformations";

/**
 * GPU-resident brush mask buffer. Replaces the previous offscreen 2D canvas
 * with a Pixi RenderTexture so the painted bitmap participates directly in
 * the existing asset-mask compositing pipeline (red-channel threshold filter
 * → boolean expression evaluator → AlphaMask). The PNG persisted on disk is
 * derived from the buffer at stroke-end via `renderer.extract`.
 */
export interface BrushBuffer {
  renderTexture: RenderTexture;
  canvasSize: { width: number; height: number };
  paintedBounds: BrushPaintedBounds | null;
  /**
   * True when the buffer has unsaved strokes. Set by paint/erase/clear,
   * cleared by `markBrushBufferClean` after a successful commit. Used by the
   * leave-triggered flush so we don't re-ingest an unchanged buffer just
   * because the user opened then closed the brush mask without painting.
   */
  dirty: boolean;
}

const buffers = new Map<string, BrushBuffer>();
const listeners = new Map<string, Set<() => void>>();

let sharedRenderer: Renderer | null = null;

const PAINT_COLOR = 0xff0000;
const ERASE_COLOR = 0x000000;

export function setBrushRenderer(renderer: Renderer | null): void {
  sharedRenderer = renderer;
}

export function getBrushBuffer(maskId: string): BrushBuffer | null {
  return buffers.get(maskId) ?? null;
}

function notify(maskId: string): void {
  listeners.get(maskId)?.forEach((listener) => listener());
}

function clearRenderTextureToBlack(buffer: BrushBuffer): void {
  if (!sharedRenderer) return;
  const filler = new Graphics()
    .rect(0, 0, buffer.canvasSize.width, buffer.canvasSize.height)
    .fill(ERASE_COLOR);
  sharedRenderer.render({
    container: filler,
    target: buffer.renderTexture,
    clear: true,
  });
  filler.destroy();
}

export function ensureBrushBuffer(
  maskId: string,
  width: number,
  height: number,
): BrushBuffer {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const existing = buffers.get(maskId);
  if (
    existing &&
    existing.canvasSize.width === w &&
    existing.canvasSize.height === h
  ) {
    return existing;
  }

  if (existing) {
    existing.renderTexture.destroy(true);
    buffers.delete(maskId);
  }

  const renderTexture = RenderTexture.create({
    width: w,
    height: h,
    dynamic: true,
  });
  const buffer: BrushBuffer = {
    renderTexture,
    canvasSize: { width: w, height: h },
    paintedBounds: null,
    dirty: false,
  };
  buffers.set(maskId, buffer);
  if (sharedRenderer) {
    clearRenderTextureToBlack(buffer);
  }
  notify(maskId);
  return buffer;
}

function expandBounds(
  current: BrushPaintedBounds | null,
  segment: { minX: number; minY: number; maxX: number; maxY: number },
  canvasSize: { width: number; height: number },
): BrushPaintedBounds {
  const minX = Math.max(0, Math.floor(segment.minX));
  const minY = Math.max(0, Math.floor(segment.minY));
  const maxX = Math.min(canvasSize.width, Math.ceil(segment.maxX));
  const maxY = Math.min(canvasSize.height, Math.ceil(segment.maxY));
  if (!current) {
    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  }
  const cMinX = Math.min(current.x, minX);
  const cMinY = Math.min(current.y, minY);
  const cMaxX = Math.max(current.x + current.width, maxX);
  const cMaxY = Math.max(current.y + current.height, maxY);
  return {
    x: cMinX,
    y: cMinY,
    width: Math.max(0, cMaxX - cMinX),
    height: Math.max(0, cMaxY - cMinY),
  };
}

function renderStroke(buffer: BrushBuffer, build: (g: Graphics) => void): void {
  if (!sharedRenderer) return;
  const graphics = new Graphics();
  build(graphics);
  sharedRenderer.render({
    container: graphics,
    target: buffer.renderTexture,
    clear: false,
  });
  graphics.destroy();
}

export function paintBrushDot(
  maskId: string,
  x: number,
  y: number,
  radius: number,
  mode: "paint" | "erase",
): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  const r = Math.max(0.5, radius);
  const color = mode === "paint" ? PAINT_COLOR : ERASE_COLOR;
  renderStroke(buffer, (g) => {
    g.circle(x, y, r).fill(color);
  });
  // Erase strokes still expand bounds — bounds are a coarse "painted region"
  // hint, not a tight filled-pixel envelope.
  buffer.paintedBounds = expandBounds(
    buffer.paintedBounds,
    { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r },
    buffer.canvasSize,
  );
  buffer.dirty = true;
  notify(maskId);
  // Wake the paused-time render loop so the player re-composites the mask
  // with the new stroke; without this the user can't see what they paint
  // until something else triggers a re-render.
  livePreviewParamStore.requestRender();
}

export function paintBrushStroke(
  maskId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  mode: "paint" | "erase",
): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  const r = Math.max(0.5, radius);
  const lineWidth = r * 2;
  const color = mode === "paint" ? PAINT_COLOR : ERASE_COLOR;
  renderStroke(buffer, (g) => {
    g.moveTo(fromX, fromY)
      .lineTo(toX, toY)
      .stroke({ width: lineWidth, color, cap: "round", join: "round" });
    // Endpoint dots so single-pixel-length segments still stamp visibly.
    g.circle(fromX, fromY, r).fill(color);
    g.circle(toX, toY, r).fill(color);
  });
  buffer.paintedBounds = expandBounds(
    buffer.paintedBounds,
    {
      minX: Math.min(fromX, toX) - r,
      minY: Math.min(fromY, toY) - r,
      maxX: Math.max(fromX, toX) + r,
      maxY: Math.max(fromY, toY) + r,
    },
    buffer.canvasSize,
  );
  buffer.dirty = true;
  notify(maskId);
  livePreviewParamStore.requestRender();
}

export function clearBrushBuffer(maskId: string): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  clearRenderTextureToBlack(buffer);
  buffer.paintedBounds = null;
  buffer.dirty = true;
  notify(maskId);
  livePreviewParamStore.requestRender();
}

export function isBrushBufferDirty(maskId: string): boolean {
  return buffers.get(maskId)?.dirty ?? false;
}

export function markBrushBufferClean(maskId: string): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  buffer.dirty = false;
}

export function disposeBrushBuffer(maskId: string): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  buffer.renderTexture.destroy(true);
  buffers.delete(maskId);
  notify(maskId);
}

export function setBrushPaintedBounds(
  maskId: string,
  bounds: BrushPaintedBounds | null,
): void {
  const buffer = buffers.get(maskId);
  if (!buffer) return;
  buffer.paintedBounds = bounds;
  notify(maskId);
}

/**
 * Extract the buffer to a binary red-on-black PNG, optionally cropped to the
 * given bounds (defaults to `buffer.paintedBounds`, falling back to full canvas).
 * Returns null when the renderer is not yet wired or the bounds are empty.
 */
export async function extractBrushPng(
  maskId: string,
  bounds?: BrushPaintedBounds | null,
): Promise<Blob | null> {
  const buffer = buffers.get(maskId);
  if (!buffer || !sharedRenderer) return null;

  const cropTarget =
    bounds ??
    buffer.paintedBounds ?? {
      x: 0,
      y: 0,
      width: buffer.canvasSize.width,
      height: buffer.canvasSize.height,
    };
  if (cropTarget.width <= 0 || cropTarget.height <= 0) return null;

  // Render the cropped sub-rect of the buffer into a fresh small RenderTexture,
  // then extract that. Keeps the on-disk PNG tight to the painted region.
  const cropped = RenderTexture.create({
    width: Math.ceil(cropTarget.width),
    height: Math.ceil(cropTarget.height),
  });
  const sourceSprite = new Sprite(buffer.renderTexture);
  sourceSprite.position.set(-cropTarget.x, -cropTarget.y);
  sharedRenderer.render({
    container: sourceSprite,
    target: cropped,
    clear: true,
  });
  sourceSprite.destroy();

  const extract = sharedRenderer.extract;
  let blob: Blob | null = null;
  try {
    if (extract && typeof extract.canvas === "function") {
      const canvas = await Promise.resolve(extract.canvas(cropped));
      const htmlCanvas = canvas as HTMLCanvasElement;
      blob = await new Promise<Blob | null>((resolve) => {
        if (typeof htmlCanvas.toBlob === "function") {
          htmlCanvas.toBlob((b) => resolve(b), "image/png");
        } else {
          resolve(null);
        }
      });
    }
  } finally {
    cropped.destroy(true);
  }
  return blob;
}

/**
 * Hydrate the brush buffer's RenderTexture from a previously-saved PNG. The
 * PNG was cropped to `bounds` on save, so it's pasted at `bounds.x/y` in the
 * canvas coordinate space; the rest of the buffer remains transparent.
 */
export async function hydrateBrushBufferFromUrl(
  maskId: string,
  url: string,
  canvasWidth: number,
  canvasHeight: number,
  bounds: BrushPaintedBounds | null,
): Promise<BrushBuffer> {
  const buffer = ensureBrushBuffer(maskId, canvasWidth, canvasHeight);
  if (!sharedRenderer) {
    buffer.paintedBounds = bounds;
    buffer.dirty = false;
    notify(maskId);
    return buffer;
  }

  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to load brush PNG"));
    image.src = url;
  });
  const texture = Texture.from(image);
  const sprite = new Sprite(texture);
  // Place cropped PNG back at its original canvas-space position.
  if (bounds) {
    sprite.position.set(bounds.x, bounds.y);
    sprite.width = bounds.width;
    sprite.height = bounds.height;
  } else {
    sprite.position.set(0, 0);
    sprite.width = canvasWidth;
    sprite.height = canvasHeight;
  }
  // Use a Container so we can clear the buffer to black first, then layer the
  // PNG on top — preserves erase regions outside the cropped area as black.
  const container = new Container();
  const blackBg = new Graphics()
    .rect(0, 0, canvasWidth, canvasHeight)
    .fill(ERASE_COLOR);
  container.addChild(blackBg);
  container.addChild(sprite);
  sharedRenderer.render({
    container,
    target: buffer.renderTexture,
    clear: true,
  });
  blackBg.destroy();
  sprite.destroy();
  texture.destroy(true);

  buffer.paintedBounds = bounds;
  // Hydration mirrors what's already on disk — no commit required.
  buffer.dirty = false;
  notify(maskId);
  return buffer;
}

export function subscribeToBrushBuffer(
  maskId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(maskId);
  if (!set) {
    set = new Set();
    listeners.set(maskId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(maskId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(maskId);
    }
  };
}
