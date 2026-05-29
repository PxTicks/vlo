import { create } from "zustand";

/**
 * Process-wide debug flag for dev-only affordances (extra panels, visible
 * cues, console noise). Ephemeral — not persisted to disk; flip it via the
 * Debug section in the project settings menu (which only appears in dev
 * builds).
 *
 * Reading the flag:
 *   - React: `useDebugStore((s) => s.debugMode)`
 *   - Non-React (utilities, render loops): `useDebugStore.getState().debugMode`
 */
interface DebugState {
  debugMode: boolean;
  setDebugMode: (next: boolean) => void;
  toggleDebugMode: () => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  debugMode: false,
  setDebugMode: (next) => set({ debugMode: next }),
  toggleDebugMode: () => set((state) => ({ debugMode: !state.debugMode })),
}));
