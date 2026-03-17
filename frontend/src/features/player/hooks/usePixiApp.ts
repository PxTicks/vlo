
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { usePlayerStore } from "../usePlayerStore";


export function usePixiApp(
  containerRef: React.RefObject<HTMLDivElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>
) {
  const [app, setApp] = useState<Application | null>(null);
  // We return the actual container size as the "canvasSize"
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const appRef = useRef<Application | null>(null);

  // 1. Initialize Pixi App (Run ONCE)
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || appRef.current) return;

    const initApp = async () => {
      // Get initial dimensions from container
      const { clientWidth, clientHeight } = containerRef.current!;
      
      const pixiApp = new Application();
      
      await pixiApp.init({
        canvas: canvasRef.current!,
        width: clientWidth,
        height: clientHeight,
        backgroundColor: 0x000000,
        backgroundAlpha: 0, 
        antialias: true,
        // autoDensity handles devicePixelRatio scaling for the backing buffer
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        autoStart: false, // Disable internal ticker
        sharedTicker: false, // Use isolated ticker (though we won't use it)
      });

      // Enable global interactivity for the stage to handle drag events outside sprites
      pixiApp.stage.eventMode = 'static';
      pixiApp.stage.hitArea = pixiApp.screen;

      appRef.current = pixiApp;
      setApp(pixiApp);
      setCanvasSize({ width: clientWidth, height: clientHeight });
    };

    initApp();

    return () => {
      if (appRef.current) {
        appRef.current.destroy(false, { children: true, texture: true });
        appRef.current = null;
        setApp(null);
      }
    };
  }, [canvasRef, containerRef]); // Run once on mount (refs are stable)

  // 2. Handle Container Resize (CSS & Renderer)
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const handleResize = (entries: ResizeObserverEntry[]) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        
        // Update Local State for consumers
        setCanvasSize({ width, height });

        // Optimize: Update Pixi Renderer directly
        if (appRef.current && appRef.current.renderer) {
             appRef.current.renderer.resize(width, height);
        }
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef, canvasRef]);

  // Note: We intentionally DO NOT react to projectDimensions changes here for resizing.
  // The Project Dimensions are for the Viewport/World logic, not the backing canvas size.

  // 3. Ticker Control (Pause = Run Ticker, Play = Stop Ticker)
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  
  useEffect(() => {
    if (!app) return;
    
    if (isPlaying) {
      // During playback, Player.tsx drives rendering via Audio Clock
      app.ticker.stop();
    } else {
      // When paused, run ticker to handle interaction/drag events & async scrub updates
      app.ticker.start();
    }
  }, [app, isPlaying]);

  return { pixiApp: app, canvasSize };
}
