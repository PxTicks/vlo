import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Container, Graphics, Sprite } from "pixi.js";
import {
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Sprite as PixiSprite,
  Texture,
} from "pixi.js";

export interface MaskOverlayScene {
  clipOverlayRef: MutableRefObject<Container | null>;
  maskOverlayRef: MutableRefObject<Container | null>;
  maskGraphicsRef: MutableRefObject<Graphics | null>;
  sam2PointsGraphicsRef: MutableRefObject<Graphics | null>;
  sam2PreviewSpriteRef: MutableRefObject<Sprite | null>;
  pathOverlayRef: MutableRefObject<Graphics | null>;
  gizmoTarget: Container | null;
}

interface UseMaskOverlaySceneOptions {
  viewport: Container | null;
  trackZIndex: number;
  sam2BorderColor: number;
  onDispose?: () => void;
}

export function useMaskOverlayScene({
  viewport,
  trackZIndex,
  sam2BorderColor,
  onDispose,
}: UseMaskOverlaySceneOptions): MaskOverlayScene {
  const clipOverlayRef = useRef<Container | null>(null);
  const maskOverlayRef = useRef<Container | null>(null);
  const maskGraphicsRef = useRef<Graphics | null>(null);
  const sam2PointsGraphicsRef = useRef<Graphics | null>(null);
  const sam2PreviewSpriteRef = useRef<Sprite | null>(null);
  const pathOverlayRef = useRef<Graphics | null>(null);
  const [gizmoTarget, setGizmoTarget] = useState<Container | null>(null);

  useEffect(() => {
    if (!viewport) return;

    const clipOverlay = new PixiContainer();
    const maskOverlay = new PixiContainer();
    const maskGraphics = new PixiGraphics();
    const sam2PointsGraphics = new PixiGraphics();
    const sam2PreviewSprite = new PixiSprite();
    const pathOverlay = new PixiGraphics();

    sam2PreviewSprite.anchor.set(0.5);
    sam2PreviewSprite.alpha = 0.45;
    sam2PreviewSprite.tint = sam2BorderColor;
    sam2PreviewSprite.visible = false;
    sam2PreviewSprite.eventMode = "none";

    pathOverlay.eventMode = "none";
    pathOverlay.visible = false;

    maskOverlay.addChild(maskGraphics);
    sam2PointsGraphics.eventMode = "none";
    clipOverlay.addChild(sam2PreviewSprite);
    clipOverlay.addChild(sam2PointsGraphics);
    clipOverlay.addChild(maskOverlay);
    clipOverlay.addChild(pathOverlay);
    clipOverlay.zIndex = trackZIndex + 0.5;
    clipOverlay.visible = false;

    viewport.addChild(clipOverlay);
    viewport.sortChildren();

    clipOverlayRef.current = clipOverlay;
    maskOverlayRef.current = maskOverlay;
    maskGraphicsRef.current = maskGraphics;
    sam2PointsGraphicsRef.current = sam2PointsGraphics;
    sam2PreviewSpriteRef.current = sam2PreviewSprite;
    pathOverlayRef.current = pathOverlay;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGizmoTarget(maskOverlay);

    return () => {
      const previewTex = sam2PreviewSprite.texture;
      if (previewTex && previewTex !== Texture.EMPTY && !previewTex.destroyed) {
        previewTex.destroy(true);
      }

      if (viewport && !viewport.destroyed) {
        viewport.removeChild(clipOverlay);
      }
      clipOverlay.destroy({ children: true });
      clipOverlayRef.current = null;
      maskOverlayRef.current = null;
      maskGraphicsRef.current = null;
      sam2PointsGraphicsRef.current = null;
      sam2PreviewSpriteRef.current = null;
      pathOverlayRef.current = null;
      setGizmoTarget(null);
      onDispose?.();
    };
  }, [onDispose, sam2BorderColor, trackZIndex, viewport]);

  return {
    clipOverlayRef,
    maskOverlayRef,
    maskGraphicsRef,
    sam2PointsGraphicsRef,
    sam2PreviewSpriteRef,
    pathOverlayRef,
    gizmoTarget,
  };
}
