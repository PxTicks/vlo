import { create } from "zustand";

export type SamAudioExtractDialogView =
  | "choose"
  | "configure"
  | "processing";

export interface SamAudioExtractRange {
  startTick: number;
  endTick: number;
}

export interface SamAudioExtractDialogState {
  open: boolean;
  view: SamAudioExtractDialogView;
  clipId: string | null;
  promptText: string;
  range: SamAudioExtractRange | null;
  error: string | null;
  statusMessage: string;
  progress: number;
  activeJobId: string | null;
  cancelRequested: boolean;
  openForClip: (clipId: string) => void;
  reopenConfigure: () => void;
  hideForTimelineSelection: () => void;
  close: () => void;
  showConfigure: () => void;
  showProcessing: () => void;
  setPromptText: (promptText: string) => void;
  setRange: (range: SamAudioExtractRange | null) => void;
  setError: (error: string | null) => void;
  setProgressState: (state: { message: string; progress: number }) => void;
  setActiveJobId: (jobId: string | null) => void;
  setCancelRequested: (cancelRequested: boolean) => void;
}

export const useSamAudioExtractDialogStore =
  create<SamAudioExtractDialogState>((set) => ({
    open: false,
    view: "choose",
    clipId: null,
    promptText: "",
    range: null,
    error: null,
    statusMessage: "",
    progress: 0,
    activeJobId: null,
    cancelRequested: false,
    openForClip: (clipId) =>
      set({
        open: true,
        view: "choose",
        clipId,
        promptText: "",
        range: null,
        error: null,
        statusMessage: "",
        progress: 0,
        activeJobId: null,
        cancelRequested: false,
      }),
    reopenConfigure: () =>
      set((state) =>
        state.clipId
          ? {
              open: true,
              view: "configure",
              error: null,
              statusMessage: "",
              progress: 0,
              activeJobId: null,
              cancelRequested: false,
            }
          : {},
      ),
    hideForTimelineSelection: () => set({ open: false }),
    close: () =>
      set({
        open: false,
        view: "choose",
        clipId: null,
        promptText: "",
        range: null,
        error: null,
        statusMessage: "",
        progress: 0,
        activeJobId: null,
        cancelRequested: false,
      }),
    showConfigure: () =>
      set({
        open: true,
        view: "configure",
        error: null,
        statusMessage: "",
        progress: 0,
        activeJobId: null,
        cancelRequested: false,
      }),
    showProcessing: () =>
      set({
        open: true,
        view: "processing",
        error: null,
        statusMessage: "Starting SAM-Audio separation",
        progress: 0,
        cancelRequested: false,
      }),
    setPromptText: (promptText) => set({ promptText }),
    setRange: (range) => set({ range }),
    setError: (error) => set({ error }),
    setProgressState: ({ message, progress }) =>
      set({
        statusMessage: message,
        progress: Math.max(0, Math.min(1, progress)),
      }),
    setActiveJobId: (activeJobId) => set({ activeJobId }),
    setCancelRequested: (cancelRequested) => set({ cancelRequested }),
  }));
