import type { ColorHistograms } from "./histogram";

const SAMPLE_INTERVAL_MS = 250;

export interface ColorGradeHistogramSnapshot {
  readonly before: ColorHistograms;
  readonly after: ColorHistograms;
}

type HistogramListener = (snapshot: ColorGradeHistogramSnapshot) => void;

interface HistogramSubscription {
  readonly transformId: string;
  readonly listener: HistogramListener;
}

/**
 * Renderer/UI rendezvous for input-edge histogram analysis. Subscriptions only
 * exist while a curve editor is visible, so the render path performs no
 * analysis pass or readback when the UI cannot present the result.
 */
export class ColorGradeHistogramRuntime {
  private readonly subscriptions = new Set<HistogramSubscription>();
  private readonly snapshots = new Map<string, ColorGradeHistogramSnapshot>();
  private readonly lastSampleTimes = new Map<string, number>();

  public subscribe(
    transformId: string,
    listener: HistogramListener,
  ): () => void {
    const subscription = { transformId, listener };
    this.subscriptions.add(subscription);
    const snapshot = this.snapshots.get(transformId);
    if (snapshot) listener(snapshot);
    return () => {
      this.subscriptions.delete(subscription);
      if (![...this.subscriptions].some((item) => item.transformId === transformId)) {
        this.snapshots.delete(transformId);
        this.lastSampleTimes.delete(transformId);
      }
    };
  }

  public getDueTransformIds(
    candidateIds: readonly string[],
    now = performance.now(),
  ): string[] {
    const subscribedIds = new Set(
      [...this.subscriptions].map((subscription) => subscription.transformId),
    );
    return candidateIds.filter((transformId) => {
      if (!subscribedIds.has(transformId)) return false;
      const lastSampleTime = this.lastSampleTimes.get(transformId);
      return (
        lastSampleTime === undefined ||
        now - lastSampleTime >= SAMPLE_INTERVAL_MS
      );
    });
  }

  public publish(
    transformId: string,
    snapshot: ColorGradeHistogramSnapshot,
    now = performance.now(),
  ): void {
    this.snapshots.set(transformId, snapshot);
    this.lastSampleTimes.set(transformId, now);
    this.subscriptions.forEach((subscription) => {
      if (subscription.transformId === transformId) {
        subscription.listener(snapshot);
      }
    });
  }

  public invalidate(transformId: string): void {
    this.lastSampleTimes.delete(transformId);
  }
}

export const colorGradeHistogramRuntime = new ColorGradeHistogramRuntime();
