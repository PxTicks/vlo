import { create } from "zustand";

export type DialogView =
  | "choose"
  | "export"
  | "extracting-frame"
  | "extracting-selection";

export interface ExtractState {
  // Dialog
  dialogOpen: boolean;
  dialogView: DialogView;
  openDialog: () => void;
  closeDialog: () => void;
  setDialogView: (view: DialogView) => void;

  // Frame Selection mode
  frameSelectionMode: boolean;
  enterFrameSelectionMode: () => void;
  exitFrameSelectionMode: () => void;

  // Callback set by Player.tsx, invoked by SelectionOverlay on confirm
  onConfirmSelection: (() => void) | null;
  setOnConfirmSelection: (cb: (() => void) | null) => void;
  onCancelSelection: (() => void) | null;
  setOnCancelSelection: (cb: (() => void) | null) => void;

  // Processing progress (shared)
  isProcessing: boolean;
  progress: number;
  setProgress: (p: number) => void;
  setIsProcessing: (v: boolean) => void;
}

export const useExtractStore = create<ExtractState>((set) => ({
  dialogOpen: false,
  dialogView: "choose",
  openDialog: () => set({ dialogOpen: true, dialogView: "choose" }),
  closeDialog: () =>
    set({
      dialogOpen: false,
      dialogView: "choose",
      isProcessing: false,
      progress: 0,
  }),
  setDialogView: (view) => set({ dialogView: view }),

  frameSelectionMode: false,
  enterFrameSelectionMode: () => set({ frameSelectionMode: true }),
  exitFrameSelectionMode: () => set({ frameSelectionMode: false }),

  onConfirmSelection: null,
  // Arming a confirm handler begins a new selection flow, so it also clears any
  // cancel handler left over from a previous flow. Only the ComfyUI editor arms
  // a cancel handler (to reopen itself); without this reset it could outlive a
  // takeover by another flow and fire on that flow's unrelated cancel. A flow
  // that wants both handlers (the editor) must set confirm first, then cancel.
  setOnConfirmSelection: (cb) =>
    set({ onConfirmSelection: cb, onCancelSelection: null }),
  onCancelSelection: null,
  setOnCancelSelection: (cb) => set({ onCancelSelection: cb }),

  isProcessing: false,
  progress: 0,
  setProgress: (p) => set({ progress: p }),
  setIsProcessing: (v) => set({ isProcessing: v }),
}));
