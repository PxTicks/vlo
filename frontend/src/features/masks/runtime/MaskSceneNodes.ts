import type { Container, Filter, Graphics, RenderTexture, Sprite } from "pixi.js";
import type { BrushBufferMaskSource } from "./BrushBufferMaskSource";
import type { MaskVideoFramePlayer } from "./MaskVideoFramePlayer";

export type AssetMaskFrameSource = MaskVideoFramePlayer | BrushBufferMaskSource;

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
  thresholdFilter: Filter;
  kind: "video" | "image";
}

export interface AssetMaskNodeEntry {
  maskId: string;
  assetId: string;
  kind: "video" | "image";
}
