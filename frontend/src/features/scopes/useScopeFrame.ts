import { useEffect, useState } from "react";
import {
  getActivePixiContentTarget,
  readActivePixiContentPixels,
} from "../../core/pixi/activeApplication";
import type { ScopeFrameSample } from "./scopeRegistry";

const SAMPLE_MAX_WIDTH = 512;
const SAMPLE_INTERVAL_MS = 110;

/**
 * Samples the composited frame while the dock is open. Analysis is deliberately
 * not done here: the dock hands the raw sample to whichever scope is showing,
 * so a contributed scope sees the same pixels the built-in ones do.
 */
export function useScopeFrame(enabled: boolean): ScopeFrameSample | null {
  const [frame, setFrame] = useState<ScopeFrameSample | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sample = (): void => {
      const startedAt = performance.now();
      if (document.visibilityState !== "hidden") {
        const content = getActivePixiContentTarget();
        if (content) {
          try {
            const resolution = Math.min(
              1,
              SAMPLE_MAX_WIDTH / Math.max(1, content.frame.width),
            );
            const extracted = readActivePixiContentPixels(
              content.frame,
              resolution,
            );
            if (!disposed && extracted) {
              setFrame({
                pixels: extracted.pixels,
                width: extracted.width,
                height: extracted.height,
                sampledAt: performance.now(),
              });
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

  return frame;
}
