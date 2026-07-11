import { useEffect, useState } from "react";
import {
  getActivePixiApplication,
  getActivePixiContentTarget,
} from "../../core/pixi/activeApplication";
import { analyzeScopePixels, type ScopeSnapshot } from "./scopeAnalysis";

const SAMPLE_MAX_WIDTH = 512;
const SAMPLE_INTERVAL_MS = 110;

export function useScopeSnapshot(enabled: boolean): ScopeSnapshot | null {
  const [snapshot, setSnapshot] = useState<ScopeSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sample = (): void => {
      const startedAt = performance.now();
      if (document.visibilityState !== "hidden") {
        const application = getActivePixiApplication();
        const content = getActivePixiContentTarget();
        if (application && content) {
          try {
            const resolution = Math.min(
              1,
              SAMPLE_MAX_WIDTH / Math.max(1, content.frame.width),
            );
            const extracted = application.renderer.extract.pixels({
              target: content.target,
              frame: content.frame,
              resolution,
            });
            if (!disposed) {
              setSnapshot(
                analyzeScopePixels(
                  extracted.pixels,
                  extracted.width,
                  extracted.height,
                  performance.now(),
                ),
              );
            }
          } catch {
            // A renderer can be replaced while the dock is open; retry next tick.
          }
        }
      }
      if (!disposed) {
        const elapsed = performance.now() - startedAt;
        timer = setTimeout(sample, Math.max(16, SAMPLE_INTERVAL_MS - elapsed));
      }
    };

    sample();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled]);

  return snapshot;
}
