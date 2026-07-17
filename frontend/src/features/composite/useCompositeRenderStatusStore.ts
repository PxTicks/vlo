import { create } from "zustand";

interface CompositeRenderStatusState {
  renderingClipIds: ReadonlySet<string>;
  directRenderErrors: ReadonlyMap<string, string>;
  beginRender: (clipId: string) => void;
  endRender: (clipId: string) => void;
  reportDirectRenderError: (placementId: string, message: string) => void;
  clearDirectRenderError: (placementId: string) => void;
}

export const useCompositeRenderStatusStore =
  create<CompositeRenderStatusState>((set) => ({
    renderingClipIds: new Set<string>(),
    directRenderErrors: new Map<string, string>(),
    beginRender: (clipId) =>
      set((state) => {
        if (state.renderingClipIds.has(clipId)) return state;
        const next = new Set(state.renderingClipIds);
        next.add(clipId);
        return { renderingClipIds: next };
      }),
    reportDirectRenderError: (placementId, message) =>
      set((state) => {
        if (state.directRenderErrors.get(placementId) === message) return state;
        const next = new Map(state.directRenderErrors);
        next.set(placementId, message);
        return { directRenderErrors: next };
      }),
    clearDirectRenderError: (placementId) =>
      set((state) => {
        if (!state.directRenderErrors.has(placementId)) return state;
        const next = new Map(state.directRenderErrors);
        next.delete(placementId);
        return { directRenderErrors: next };
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

export function reportCompositeDirectRenderError(
  placementId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  useCompositeRenderStatusStore
    .getState()
    .reportDirectRenderError(placementId, message);
}

export function clearCompositeDirectRenderError(placementId: string): void {
  useCompositeRenderStatusStore.getState().clearDirectRenderError(placementId);
}

export function useCompositeDirectRenderError(
  placementId: string | undefined,
): string | null {
  return useCompositeRenderStatusStore((state) =>
    placementId ? (state.directRenderErrors.get(placementId) ?? null) : null,
  );
}
