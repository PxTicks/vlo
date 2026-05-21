import { create } from "zustand";

interface CompositeRenderStatusState {
  renderingClipIds: ReadonlySet<string>;
  beginRender: (clipId: string) => void;
  endRender: (clipId: string) => void;
}

export const useCompositeRenderStatusStore =
  create<CompositeRenderStatusState>((set) => ({
    renderingClipIds: new Set<string>(),
    beginRender: (clipId) =>
      set((state) => {
        if (state.renderingClipIds.has(clipId)) return state;
        const next = new Set(state.renderingClipIds);
        next.add(clipId);
        return { renderingClipIds: next };
      }),
    endRender: (clipId) =>
      set((state) => {
        if (!state.renderingClipIds.has(clipId)) return state;
        const next = new Set(state.renderingClipIds);
        next.delete(clipId);
        return { renderingClipIds: next };
      }),
  }));

export function beginCompositeRender(clipId: string): void {
  useCompositeRenderStatusStore.getState().beginRender(clipId);
}

export function endCompositeRender(clipId: string): void {
  useCompositeRenderStatusStore.getState().endRender(clipId);
}

export function useIsCompositeRendering(clipId: string | undefined): boolean {
  return useCompositeRenderStatusStore((state) =>
    clipId ? state.renderingClipIds.has(clipId) : false,
  );
}
