import { useEffect, useRef, useState } from "react";
import { Application, Graphics } from "pixi.js";
import { Viewport } from "pixi-viewport";

interface ViewportConfig {
  screenWidth: number;
  screenHeight: number;
  logicalWidth: number;
  logicalHeight: number;
}

export function useViewport(app: Application | null, config: ViewportConfig) {
  const viewportRef = useRef<Viewport | null>(null);
  const maskRef = useRef<Graphics | null>(null);
  const [viewportInstance, setViewportInstance] = useState<Viewport | null>(
    null,
  );

  // Use a ref to access the latest config during initialization without adding it to dependencies
  // (We only want to initialize ONCE, not re-create the viewport on resize)
  const configRef = useRef(config);

  // Keep the ref valid so the initialization effect sees the latest data
  // Even if config changes after mount but before 'app' exists.
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // 1. Initialize Viewport
  useEffect(() => {
    if (!app) return;

    // Use initial config from ref
    const { screenWidth, screenHeight, logicalWidth, logicalHeight } =
      configRef.current;

    const viewport = new Viewport({
      screenWidth,
      screenHeight,
      worldWidth: logicalWidth,
      worldHeight: logicalHeight,
      events: app.renderer.events,
      ticker: app.ticker,
      passiveWheel: false,
    });

    viewport
      // .drag()
      .pinch()
      .wheel({ smooth: false, percent: 2 })
      .decelerate();

    viewport.clampZoom({
      minScale: 0.1,
      maxScale: 10.0,
    });

    // --- Overlay / Masking ---
    // Instead of completely masking out-of-bounds content, we draw a dark overlay
    // to "grey it out". This allows gizmos and clips to remain visible and interactive.
    const overlay = new Graphics();
    overlay.zIndex = 9998; // High enough to cover tracks but below gizmos (9999)
    overlay.eventMode = "none"; // Essential: must not block pointer events!

    const drawOverlay = (w: number, h: number) => {
      const inf = 100000;
      overlay.clear();
      overlay.rect(-inf, -inf, inf * 2, inf); // Top
      overlay.rect(-inf, h, inf * 2, inf); // Bottom
      overlay.rect(-inf, 0, inf, h); // Left
      overlay.rect(w, 0, inf, h); // Right
      overlay.fill({ color: 0x000000, alpha: 0.8 });
    };

    drawOverlay(logicalWidth, logicalHeight);
    viewport.addChild(overlay);

    // Repurpose maskRef to store the overlay for resizing
    maskRef.current = overlay;

    // Center and Fit
    viewport.moveCenter(logicalWidth / 2, logicalHeight / 2);
    viewport.fit(true);

    viewport.sortableChildren = true;

    app.stage.addChild(viewport);
    viewportRef.current = viewport;

    // Avoid synchronous setState warning by deferring the update
    requestAnimationFrame(() => {
      setViewportInstance(viewport);
    });

    return () => {
      if (app.stage && !app.stage.destroyed) {
        app.stage.removeChild(viewport);
      }
      viewport.destroy({ children: true });
      viewportRef.current = null;
      maskRef.current = null;
      setViewportInstance(null);
    };
  }, [app]);

  // 2. Handle Resizing
  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.resize(
        config.screenWidth,
        config.screenHeight,
        config.logicalWidth,
        config.logicalHeight,
      );

      // Update Overlay Dimensions
      if (maskRef.current) {
        const overlay = maskRef.current;
        const w = config.logicalWidth;
        const h = config.logicalHeight;
        const inf = 100000;
        overlay.clear();
        overlay.rect(-inf, -inf, inf * 2, inf); // Top
        overlay.rect(-inf, h, inf * 2, inf); // Bottom
        overlay.rect(-inf, 0, inf, h); // Left
        overlay.rect(w, 0, inf, h); // Right
        overlay.fill({ color: 0x000000, alpha: 0.8 });
      }
    }
  }, [
    config.screenWidth,
    config.screenHeight,
    config.logicalWidth,
    config.logicalHeight,
  ]);

  return viewportInstance;
}
