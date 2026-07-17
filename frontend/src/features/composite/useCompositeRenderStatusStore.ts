import { create } from "zustand";

export interface CompositeBakeRuntimeStatus {
  status: "queued" | "rendering";
  progress: number;
  revision: number;
  requestedKey: string;
}

interface CompositeRenderStatusState {
  renderingClipIds: ReadonlySet<string>;
  directRenderErrors: ReadonlyMap<string, string>;
  bakeStatusByCompositeId: ReadonlyMap<string, CompositeBakeRuntimeStatus>;
  forceLiveCompositeIds: ReadonlySet<string>;
  forceBakedCompositeIds: ReadonlySet<string>;
  beginRender: (clipId: string) => void;
  endRender: (clipId: string) => void;
  setBakeStatus: (
    compositeId: string,
    status: CompositeBakeRuntimeStatus | null,
  ) => void;
  setForceLive: (compositeId: string, forceLive: boolean) => void;
  setForceBaked: (compositeId: string, forceBaked: boolean) => void;
  reportDirectRenderError: (placementId: string, message: string) => void;
  clearDirectRenderError: (placementId: string) => void;
}

export const useCompositeRenderStatusStore =
  create<CompositeRenderStatusState>((set) => ({
    renderingClipIds: new Set<string>(),
    directRenderErrors: new Map<string, string>(),
    bakeStatusByCompositeId: new Map<string, CompositeBakeRuntimeStatus>(),
    forceLiveCompositeIds: new Set<string>(),
    forceBakedCompositeIds: new Set<string>(),
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
    setBakeStatus: (compositeId, status) =>
      set((state) => {
        const current = state.bakeStatusByCompositeId.get(compositeId);
        if (status && current === status) return state;
        if (!status && !current) return state;
        const next = new Map(state.bakeStatusByCompositeId);
        if (status) {
          next.set(compositeId, status);
        } else {
          next.delete(compositeId);
        }
        return { bakeStatusByCompositeId: next };
      }),
    setForceLive: (compositeId, forceLive) =>
      set((state) => {
        if (state.forceLiveCompositeIds.has(compositeId) === forceLive) {
          return state;
        }
        const next = new Set(state.forceLiveCompositeIds);
        if (forceLive) {
          next.add(compositeId);
        } else {
          next.delete(compositeId);
        }
        const nextBaked = new Set(state.forceBakedCompositeIds);
        if (forceLive) nextBaked.delete(compositeId);
        return {
          forceLiveCompositeIds: next,
          forceBakedCompositeIds: nextBaked,
        };
      }),
    setForceBaked: (compositeId, forceBaked) =>
      set((state) => {
        if (state.forceBakedCompositeIds.has(compositeId) === forceBaked) {
          return state;
        }
        const next = new Set(state.forceBakedCompositeIds);
        if (forceBaked) {
          next.add(compositeId);
        } else {
          next.delete(compositeId);
        }
        const nextLive = new Set(state.forceLiveCompositeIds);
        if (forceBaked) nextLive.delete(compositeId);
        return {
          forceBakedCompositeIds: next,
          forceLiveCompositeIds: nextLive,
        };
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

export function setCompositeBakeRuntimeStatus(
  compositeId: string,
  status: CompositeBakeRuntimeStatus | null,
): void {
  useCompositeRenderStatusStore.getState().setBakeStatus(compositeId, status);
}

export function useCompositeBakeRuntimeStatus(
  compositeId: string | undefined,
): CompositeBakeRuntimeStatus | null {
  return useCompositeRenderStatusStore((state) =>
    compositeId
      ? (state.bakeStatusByCompositeId.get(compositeId) ?? null)
      : null,
  );
}

export function setCompositeForceLive(
  compositeId: string,
  forceLive: boolean,
): void {
  useCompositeRenderStatusStore.getState().setForceLive(compositeId, forceLive);
}

export function isCompositeForceLive(compositeId: string): boolean {
  return useCompositeRenderStatusStore
    .getState()
    .forceLiveCompositeIds.has(compositeId);
}

export function getCompositeForceLiveIds(): ReadonlySet<string> {
  return new Set(
    useCompositeRenderStatusStore.getState().forceLiveCompositeIds,
  );
}

export function setCompositeForceBaked(
  compositeId: string,
  forceBaked: boolean,
): void {
  useCompositeRenderStatusStore
    .getState()
    .setForceBaked(compositeId, forceBaked);
}

export function getCompositeForceBakedIds(): ReadonlySet<string> {
  return new Set(
    useCompositeRenderStatusStore.getState().forceBakedCompositeIds,
  );
}

export function useIsCompositeForceBaked(
  compositeId: string | undefined,
): boolean {
  return useCompositeRenderStatusStore((state) =>
    compositeId ? state.forceBakedCompositeIds.has(compositeId) : false,
  );
}

export function useIsCompositeForceLive(
  compositeId: string | undefined,
): boolean {
  return useCompositeRenderStatusStore((state) =>
    compositeId ? state.forceLiveCompositeIds.has(compositeId) : false,
  );
}

export function resetCompositeRenderRuntimeState(): void {
  useCompositeRenderStatusStore.setState({
    renderingClipIds: new Set<string>(),
    directRenderErrors: new Map<string, string>(),
    bakeStatusByCompositeId: new Map<string, CompositeBakeRuntimeStatus>(),
    forceLiveCompositeIds: new Set<string>(),
    forceBakedCompositeIds: new Set<string>(),
  });
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
