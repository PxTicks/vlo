import {
  getActivePixiApplication,
  getActivePixiContentTarget,
} from "../../../core/pixi/activeApplication";
import {
  buildCurveHistograms,
  type CurveHistograms,
} from "../utils/curveHistogram";

const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_MAX_DIMENSION = 256;

type HistogramListener = (histograms: CurveHistograms) => void;

class CurveHistogramSampler {
  private readonly listeners = new Set<HistogramListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: CurveHistograms | null = null;
  private sampling = false;

  public subscribe(listener: HistogramListener): () => void {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): void {
    if (this.sampling) return;
    const application = getActivePixiApplication();
    const content = getActivePixiContentTarget();
    if (!application || !content) return;
    this.sampling = true;
    try {
      const longestSide = Math.max(
        content.frame.width,
        content.frame.height,
        1,
      );
      const resolution = Math.min(1, SAMPLE_MAX_DIMENSION / longestSide);
      const result = application.renderer.extract.pixels({
        target: content.target,
        frame: content.frame,
        resolution,
      });
      const histograms = buildCurveHistograms(result.pixels);
      this.latest = histograms;
      this.listeners.forEach((listener) => listener(histograms));
    } catch {
      // Rendering can be between targets while playback is advancing; retry next tick.
    } finally {
      this.sampling = false;
    }
  }
}

export const curveHistogramSampler = new CurveHistogramSampler();
