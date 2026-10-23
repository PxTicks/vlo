import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Application } from "pixi.js";
import { usePlayerStore } from "../usePlayerStore";
import { enableAdvancedBlendModes } from "../../../core/pixi/advancedBlendModes";
import {
  isProjectExportRunning,
  subscribeExportRuns,
} from "../../../core/export/exportRunLog";
import {
  clearActivePixiApplication,
  setActivePixiApplication,
} from "../../../core/pixi/activeApplication";
import { discardBrushBuffersForRenderer } from "../../masks/runtime/brushBufferRegistry";

export function usePixiApp(
  containerRef: React.RefObject<HTMLDivElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>
) {
  const [app, setApp] = useState<Application | null>(null);
  // We return the actual container size as the "canvasSize"
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const appRef = useRef<Application | null>(null);

  const [canvasKey, setCanvasKey] = useState(0);
  const [isRecovering, setIsRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = useCallback(() => {
    setError(null);
    setIsRecovering(true);
    setCanvasKey((key) => key + 1);
  }, []);

  // Replacing the canvas gives Pixi and every scene resource a fresh context.
  // Render textures have no CPU copy to re-upload after a context loss.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let disposed = false;
    let contextLost = false;
    let initializationSettled = false;
    let pixiApp: Application | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRecovery = (delay: number) => {
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (!disposed) retry();
      }, delay);
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (disposed || contextLost) return;
      contextLost = true;
      pixiApp?.ticker?.stop();
      if (pixiApp?.renderer) discardBrushBuffersForRenderer(pixiApp.renderer);
      if (pixiApp) clearActivePixiApplication(pixiApp);
      usePlayerStore.getState().setIsPlaying(false);
      setIsRecovering(true);
      setApp(null);
      // Some GPU resets never produce a restored event on the old canvas.
      scheduleRecovery(3_000);
    };

    const handleContextRestored = () => {
      if (!disposed && contextLost) {
        // Let Pixi's own restored listener finish before retiring its renderer.
        scheduleRecovery(0);
      }
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    const initApp = async () => {
      // StrictMode may retire this effect before initialization starts.
      await Promise.resolve();
      if (disposed) return;
      enableAdvancedBlendModes();
      pixiApp = new Application();
      const application = pixiApp;

      try {
        await application.init({
          canvas,
          width: container.clientWidth,
          height: container.clientHeight,
          backgroundColor: 0x000000,
          backgroundAlpha: 0,
          antialias: true,
          // Advanced blend modes read from the back buffer on WebGL.
          useBackBuffer: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
          autoStart: false,
          sharedTicker: false,
        });
        initializationSettled = true;
        if (disposed) {
          application.destroy(false, { children: true });
          return;
        }
        appRef.current = application;
        if (contextLost) return;

        application.stage.eventMode = "static";
        application.stage.hitArea = application.screen;
        setActivePixiApplication(application);
        (window as unknown as Record<string, unknown>).__PIXI_APP__ = application;
        setApp(application);
        setCanvasSize({
          width: container.clientWidth,
          height: container.clientHeight,
        });
        setIsRecovering(false);
        setError(null);
      } catch (cause) {
        initializationSettled = true;
        if (disposed) {
          if (application.renderer) application.destroy(false, { children: true });
          return;
        }
        console.error("[Player] Preview initialization failed", cause);
        setIsRecovering(false);
        setError("The preview could not start. Try restarting the preview.");
      }
    };

    void initApp();

    return () => {
      disposed = true;
      clearTimeout(recoveryTimer);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      if (pixiApp && initializationSettled && pixiApp.renderer) {
        clearActivePixiApplication(pixiApp);
        pixiApp.destroy(false, { children: true });
      }
      if (appRef.current === pixiApp) appRef.current = null;
      const debugWindow = window as unknown as Record<string, unknown>;
      if (debugWindow.__PIXI_APP__ === pixiApp) delete debugWindow.__PIXI_APP__;
    };
  }, [canvasRef, containerRef, canvasKey, retry]);

  // 2. Handle Container Resize (CSS & Renderer)
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const handleResize = (entries: ResizeObserverEntry[]) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        
        // Update Local State for consumers
        setCanvasSize({ width, height });

        // Optimize: Update Pixi Renderer directly
        if (appRef.current?.renderer && !isRecovering && !error) {
             appRef.current.renderer.resize(width, height);
        }
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef, canvasRef, isRecovering, error]);

  // Note: We intentionally DO NOT react to projectDimensions changes here for resizing.
  // The Project Dimensions are for the Viewport/World logic, not the backing canvas size.

  // 3. Ticker Control (Pause = Run Ticker, Play = Stop Ticker)
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const projectExportRunning = useSyncExternalStore(
    subscribeExportRuns,
    isProjectExportRunning,
  );

  // Playback renders from the audio clock, not the ticker, so stopping the
  // ticker alone would leave it running beside the export. Pausing here, off
  // the run log, covers every entry point, not only the export dialog.
  useEffect(() => {
    if (projectExportRunning && isPlaying) {
      usePlayerStore.getState().setIsPlaying(false);
    }
  }, [projectExportRunning, isPlaying]);

  useEffect(() => {
    if (!app) return;

    if (isPlaying) {
      // During playback, Player.tsx drives rendering via Audio Clock
      app.ticker.stop();
    } else if (projectExportRunning) {
      // The paused ticker redraws the whole stage every frame. Behind the
      // modal export dialog that only competes with the export, which ran
      // about 3x faster once the live preview stopped (pip-render-plan.md,
      // phase 1). The canvas keeps its last frame until the export ends.
      app.ticker.stop();
    } else {
      // When paused, run ticker to handle interaction/drag events & async scrub updates
      app.ticker.start();
    }
  }, [app, isPlaying, projectExportRunning]);

  return { pixiApp: app, canvasSize, canvasKey, isRecovering, error, retry };
}
