type ParamListener = (value: number) => void;

/**
 * A zero-overhead pub/sub store for live-resolved transformation parameter values.
 *
 * Written to by `applyClipTransforms` on every render frame.
 * Read by UI controls (SliderControl, ScalarControl) via direct DOM ref updates,
 * completely bypassing the React render cycle.
 *
 * `notify` is a no-op when there are no active UI subscribers, so there is
 * zero cost when the transformation panel is closed.
 */
class LiveParamStore {
  private readonly listeners = new Map<string, Set<ParamListener>>();

  /**
   * Called by applyClipTransforms each frame with the resolved numeric value
   * of a parameter at the current playhead time.
   * No-op if no UI subscribers are registered for this (transformId, paramName).
   */
  notify(transformId: string, paramName: string, value: number): void {
    const key = `${transformId}:${paramName}`;
    const subs = this.listeners.get(key);
    if (!subs || subs.size === 0) return;
    for (const fn of subs) fn(value);
  }

  /**
   * Subscribe to live resolved values for a specific transform parameter.
   * The callback receives the resolved numeric value each frame.
   * Returns an unsubscribe function.
   */
  subscribe(transformId: string, paramName: string, fn: ParamListener): () => void {
    const key = `${transformId}:${paramName}`;
    let subs = this.listeners.get(key);
    if (!subs) {
      subs = new Set();
      this.listeners.set(key, subs);
    }
    subs.add(fn);
    return () => {
      const s = this.listeners.get(key);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.listeners.delete(key);
      }
    };
  }
}

export const liveParamStore = new LiveParamStore();
