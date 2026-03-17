type PreviewListener = () => void;

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
    const key = createKey(transformId, paramName);
    if (this.overrides.get(key) === value) {
      return;
    }

    this.overrides.set(key, value);
    this.emit();
  }

  clear(transformId: string, paramName: string): void {
    if (!this.overrides.delete(createKey(transformId, paramName))) {
      return;
    }

    this.emit();
  }

  clearAll(): void {
    if (this.overrides.size === 0) {
      return;
    }

    this.overrides.clear();
    this.emit();
  }

  subscribe(listener: PreviewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const livePreviewParamStore = new LivePreviewParamStore();
