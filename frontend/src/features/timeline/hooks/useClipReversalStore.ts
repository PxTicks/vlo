import { create } from "zustand";

interface ClipReversalState {
  /** Clip ids whose reversal (asset re-encode + hot-swap) is in flight. */
  reversingClipIds: ReadonlySet<string>;
  beginReversal: (clipId: string) => void;
  endReversal: (clipId: string) => void;
}

export const useClipReversalStore = create<ClipReversalState>((set) => ({
  reversingClipIds: new Set<string>(),
  beginReversal: (clipId) =>
    set((state) => {
      if (state.reversingClipIds.has(clipId)) return state;
      const next = new Set(state.reversingClipIds);
      next.add(clipId);
      return { reversingClipIds: next };
    }),
  endReversal: (clipId) =>
    set((state) => {
      if (!state.reversingClipIds.has(clipId)) return state;
      const next = new Set(state.reversingClipIds);
      next.delete(clipId);
      return { reversingClipIds: next };
    }),
}));

export function beginClipReversal(clipId: string): void {
  useClipReversalStore.getState().beginReversal(clipId);
}

export function endClipReversal(clipId: string): void {
  useClipReversalStore.getState().endReversal(clipId);
}

/** Reactive selector: is the given clip currently being reversed? */
export function useIsClipReversing(clipId: string | undefined): boolean {
  return useClipReversalStore((state) =>
    clipId ? state.reversingClipIds.has(clipId) : false,
  );
}
