import type { Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import type { BrushBufferMaskSource } from "./BrushBufferMaskSource";
import type { ImageMaskSource } from "./ImageMaskSource";
import type { MaskAssetDecodeFilter } from "./MaskAssetDecodeFilter";
import type { MaskVideoFramePlayer } from "./MaskVideoFramePlayer";

export type AssetMaskFrameSource =
  | MaskVideoFramePlayer
  | ImageMaskSource
  | BrushBufferMaskSource;

export interface VectorMaskNode {
  root: Container;
  graphics: Graphics;
  spriteHost: Container;
  sprite: Sprite;
  shapeSignature: string;
  rasterSignature: string;
  rasterTexture: RenderTexture | null;
  rasterWidth: number;
  rasterHeight: number;
  presentation: "graphics" | "sprite";
}

export interface AssetMaskNode {
  root: Container;
  player: AssetMaskFrameSource;
  assetId: string;
  /** Turns the asset's frames into coverage for its encoding. */
  decodeFilter: MaskAssetDecodeFilter;
  kind: "video" | "image" | "brush";
}

export interface AssetMaskNodeEntry {
  maskId: string;
  assetId: string;
  kind: "video" | "image" | "brush";
}
