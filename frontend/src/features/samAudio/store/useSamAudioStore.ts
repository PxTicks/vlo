import { create } from "zustand";
import type { SamAudioJobStatus } from "../services/samAudioApi";

interface SamAudioState {
  promptText: string;
  useSpanPrompt: boolean;
  useVisualPrompt: boolean;
  activeJobId: string | null;
  jobStatus: SamAudioJobStatus | null;
  error: string | null;
  setPromptText: (value: string) => void;
  setUseSpanPrompt: (value: boolean) => void;
  setUseVisualPrompt: (value: boolean) => void;
  setActiveJob: (jobId: string | null) => void;
  setJobStatus: (status: SamAudioJobStatus | null) => void;
  setError: (error: string | null) => void;
  resetJob: () => void;
}

export const useSamAudioStore = create<SamAudioState>((set) => ({
  promptText: "",
  useSpanPrompt: false,
  useVisualPrompt: false,
  activeJobId: null,
  jobStatus: null,
  error: null,
  setPromptText: (promptText) => set({ promptText }),
  setUseSpanPrompt: (useSpanPrompt) => set({ useSpanPrompt }),
  setUseVisualPrompt: (useVisualPrompt) => set({ useVisualPrompt }),
  setActiveJob: (activeJobId) => set({ activeJobId, jobStatus: null, error: null }),
  setJobStatus: (jobStatus) => set({ jobStatus }),
  setError: (error) => set({ error }),
  resetJob: () => set({ activeJobId: null, jobStatus: null, error: null }),
}));
