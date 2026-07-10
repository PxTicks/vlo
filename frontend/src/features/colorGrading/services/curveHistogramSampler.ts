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

interface HistogramSubscription {
  readonly referenceKey: string;
  readonly listener: HistogramListener;
}

export class CurveHistogramSampler {
  private readonly subscriptions = new Set<HistogramSubscription>();
  private readonly references = new Map<string, CurveHistograms>();
  private readonly pendingReferenceKeys = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  public subscribe(
    referenceKey: string,
    listener: HistogramListener,
  ): () => void {
    const subscription = { referenceKey, listener };
    this.subscriptions.add(subscription);
    const reference = this.references.get(referenceKey);
    if (reference) {
      listener(reference);
    } else {
      this.pendingReferenceKeys.add(referenceKey);
      if (this.timer === null) this.start();
    }
    return () => {
      this.subscriptions.delete(subscription);
      const stillSubscribed = [...this.subscriptions].some(
        (current) => current.referenceKey === referenceKey,
      );
      if (!stillSubscribed) {
        this.references.delete(referenceKey);
        this.pendingReferenceKeys.delete(referenceKey);
      }
      if (this.pendingReferenceKeys.size === 0) this.stop();
    };
  }

  private start(): void {
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.sample();
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
      const capturedKeys = new Set(this.pendingReferenceKeys);
      capturedKeys.forEach((referenceKey) => {
        this.references.set(referenceKey, histograms);
      });
      this.pendingReferenceKeys.clear();
      this.subscriptions.forEach((subscription) => {
        if (capturedKeys.has(subscription.referenceKey)) {
          subscription.listener(histograms);
        }
      });
      this.stop();
    } catch {
      // Rendering can be between targets while playback is advancing; retry next tick.
    } finally {
      this.sampling = false;
    }
  }
}

export const curveHistogramSampler = new CurveHistogramSampler();
