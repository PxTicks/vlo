import { create } from "zustand";

interface PlayerState {
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  togglePlay: () => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
}));
