export interface LivePreviewParamUpdate {
  transformId: string;
  paramName: string;
  value: number;
}

export interface LivePreviewParamKey {
  transformId: string;
  paramName: string;
}

export type LivePreviewParamChange =
  | { kind: "set"; parameters: readonly LivePreviewParamKey[] }
  | { kind: "clear"; parameters: readonly LivePreviewParamKey[] }
  | { kind: "clear-all" }
  | { kind: "request-render" };

type PreviewListener = (change: LivePreviewParamChange) => void;

function createKey(transformId: string, paramName: string): string {
  return `${transformId}:${paramName}`;
}

/**
 * Transient parameter overrides used for interactive previews.
 *
 * Unlike persisted transform state, these values exist only while a control is
 * being dragged. The renderer consults them to preview a value without forcing
 * the timeline model through undo/persist work on every pointer move.
 */
class LivePreviewParamStore {
  private readonly overrides = new Map<string, number>();
  private readonly listeners = new Set<PreviewListener>();

  get(transformId: string, paramName: string): number | undefined {
    return this.overrides.get(createKey(transformId, paramName));
  }

  set(transformId: string, paramName: string, value: number): void {
    this.setMany([{ transformId, paramName, value }]);
  }

  setMany(updates: readonly LivePreviewParamUpdate[]): void {
    const changed: LivePreviewParamKey[] = [];
    for (const update of updates) {
      const key = createKey(update.transformId, update.paramName);
      if (this.overrides.get(key) === update.value) {
        continue;
      }
      this.overrides.set(key, update.value);
      changed.push({
        transformId: update.transformId,
        paramName: update.paramName,
      });
    }
    if (changed.length > 0) {
      this.emit({ kind: "set", parameters: changed });
    }
  }

  clear(transformId: string, paramName: string): void {
    this.clearMany([{ transformId, paramName }]);
  }

  clearMany(parameters: readonly LivePreviewParamKey[]): void {
    const changed: LivePreviewParamKey[] = [];
    for (const parameter of parameters) {
      if (
        !this.overrides.delete(
          createKey(parameter.transformId, parameter.paramName),
        )
      ) {
        continue;
      }
      changed.push(parameter);
    }
    if (changed.length > 0) {
      this.emit({ kind: "clear", parameters: changed });
    }
  }

  clearAll(): void {
    if (this.overrides.size === 0) {
      return;
    }

    this.overrides.clear();
    this.emit({ kind: "clear-all" });
  }

  /**
   * Wake any subscribers without changing stored overrides. Used by sources
   * that need to drive a paused-time re-render via this store's existing
   * subscription (e.g. brush strokes mutating a GPU buffer the renderer
   * reads on its next pass).
   */
  requestRender(): void {
    this.emit({ kind: "request-render" });
  }

  subscribe(listener: PreviewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: LivePreviewParamChange): void {
    this.listeners.forEach((listener) => listener(change));
  }
}

export const livePreviewParamStore = new LivePreviewParamStore();
