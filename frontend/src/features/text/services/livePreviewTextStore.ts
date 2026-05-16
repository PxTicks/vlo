import type { TextClipData } from "../../../types/TimelineTypes";

type PreviewListener = () => void;

function hasEntries(value: Partial<TextClipData>): boolean {
  return Object.keys(value).length > 0;
}

class LivePreviewTextStore {
  private readonly overrides = new Map<string, Partial<TextClipData>>();
  private readonly listeners = new Set<PreviewListener>();

  get(clipId: string): Partial<TextClipData> | undefined {
    return this.overrides.get(clipId);
  }

  set(clipId: string, updates: Partial<TextClipData>): void {
    const current = this.overrides.get(clipId) ?? {};
    const next = { ...current, ...updates };
    const changed = Object.keys(updates).some(
      (key) =>
        current[key as keyof TextClipData] !== next[key as keyof TextClipData],
    );

    if (!changed) {
      return;
    }

    this.overrides.set(clipId, next);
    this.emit();
  }

  clear(clipId: string, fields?: (keyof TextClipData)[]): void {
    if (!this.overrides.has(clipId)) {
      return;
    }

    if (!fields || fields.length === 0) {
      this.overrides.delete(clipId);
      this.emit();
      return;
    }

    const current = this.overrides.get(clipId);
    if (!current) {
      return;
    }

    const next = { ...current };
    let changed = false;

    fields.forEach((field) => {
      if (field in next) {
        delete next[field];
        changed = true;
      }
    });

    if (!changed) {
      return;
    }

    if (hasEntries(next)) {
      this.overrides.set(clipId, next);
    } else {
      this.overrides.delete(clipId);
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

export const livePreviewTextStore = new LivePreviewTextStore();
