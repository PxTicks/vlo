import { create } from "zustand";

export type CanvasSelection =
  | { kind: "clip"; clipId: string }
  | { kind: "mask"; clipId: string; maskId: string };

interface CanvasSelectionState {
  activeSelection: CanvasSelection | null;
  selectClip: (clipId: string) => void;
  selectMask: (clipId: string, maskId: string) => void;
  clearSelection: () => void;
}

export const useCanvasSelectionStore = create<CanvasSelectionState>((set) => ({
  activeSelection: null,
  selectClip: (clipId) =>
    set((state) =>
      state.activeSelection?.kind === "clip" &&
      state.activeSelection.clipId === clipId
        ? state
        : { activeSelection: { kind: "clip", clipId } },
    ),
  selectMask: (clipId, maskId) =>
    set((state) =>
      state.activeSelection?.kind === "mask" &&
      state.activeSelection.clipId === clipId &&
      state.activeSelection.maskId === maskId
        ? state
        : { activeSelection: { kind: "mask", clipId, maskId } },
    ),
  clearSelection: () => set({ activeSelection: null }),
}));
