import { create } from "zustand";

export type ScopeKind = "waveform" | "parade" | "vectorscope" | "histogram";

interface ScopesState {
  open: boolean;
  kind: ScopeKind;
  setOpen(open: boolean): void;
  toggle(): void;
  setKind(kind: ScopeKind): void;
}

export const useScopesStore = create<ScopesState>((set) => ({
  open: false,
  kind: "waveform",
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  setKind: (kind) => set({ kind }),
}));
