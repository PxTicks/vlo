import { create } from "zustand";
import type { ClipMaskType } from "../../../types/TimelineTypes";

export interface PendingMaskDrawRequest {
  clipId: string;
  shape: ClipMaskType;
}

export interface MaskInteractionContext {
  clipId: string;
  mode: "draw" | "edit";
  maskId: string | null;
}

export interface Sam2LivePreview {
  maskId: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  frameIndex: number;
  sourceFps: number;
}

export type Sam2PointMode = "add" | "remove";

interface MaskViewState {
  selectedMaskByClipId: Record<string, string | undefined>;
  sam2EditorMaskByClipId: Record<string, string | undefined>;
  isMaskTabActive: boolean;
  pendingDrawRequest: PendingMaskDrawRequest | null;
  interactionContext: MaskInteractionContext | null;
  sam2LivePreviewByClipId: Record<string, Sam2LivePreview | undefined>;
  sam2PointMode: Sam2PointMode;
  setSelectedMask: (clipId: string, maskId: string | null) => void;
  setSam2EditorMask: (clipId: string, maskId: string | null) => void;
  setMaskTabActive: (isActive: boolean) => void;
  requestMaskDraw: (clipId: string, shape: ClipMaskType) => void;
  clearPendingDraw: () => void;
  setInteractionContext: (context: MaskInteractionContext | null) => void;
  setSam2PointMode: (mode: Sam2PointMode) => void;
  setSam2LivePreview: (
    clipId: string,
    maskId: string,
    bitmap: ImageBitmap,
    width: number,
    height: number,
    frameIndex: number,
    sourceFps: number,
  ) => void;
  clearSam2LivePreview: (clipId: string) => void;
  clearClipState: (clipId: string) => void;
}

export const useMaskViewStore = create<MaskViewState>((set) => ({
  selectedMaskByClipId: {},
  sam2EditorMaskByClipId: {},
  isMaskTabActive: false,
  pendingDrawRequest: null,
  interactionContext: null,
  sam2LivePreviewByClipId: {},
  sam2PointMode: "add",

  setSelectedMask: (clipId, maskId) =>
    set((state) => {
      if (maskId === null) {
        const next = { ...state.selectedMaskByClipId };
        delete next[clipId];
        return { selectedMaskByClipId: next };
      }

      return {
        selectedMaskByClipId: {
          ...state.selectedMaskByClipId,
          [clipId]: maskId,
        },
      };
    }),

  setSam2EditorMask: (clipId, maskId) =>
    set((state) => {
      if (maskId === null) {
        const next = { ...state.sam2EditorMaskByClipId };
        delete next[clipId];
        return { sam2EditorMaskByClipId: next };
      }

      return {
        sam2EditorMaskByClipId: {
          ...state.sam2EditorMaskByClipId,
          [clipId]: maskId,
        },
      };
    }),

  setMaskTabActive: (isActive) => set({ isMaskTabActive: isActive }),

  requestMaskDraw: (clipId, shape) =>
    set({
      pendingDrawRequest: { clipId, shape },
      interactionContext: { clipId, mode: "draw", maskId: null },
    }),

  clearPendingDraw: () =>
    set((state) => ({
      pendingDrawRequest: null,
      interactionContext:
        state.interactionContext?.mode === "draw"
          ? null
          : state.interactionContext,
    })),

  setInteractionContext: (context) => set({ interactionContext: context }),

  setSam2PointMode: (mode) => set({ sam2PointMode: mode }),

  setSam2LivePreview: (
    clipId,
    maskId,
    bitmap,
    width,
    height,
    frameIndex,
    sourceFps,
  ) =>
    set((state) => {
      const previous = state.sam2LivePreviewByClipId[clipId];
      if (previous) {
        previous.bitmap.close();
      }
      return {
        sam2LivePreviewByClipId: {
          ...state.sam2LivePreviewByClipId,
          [clipId]: { maskId, bitmap, width, height, frameIndex, sourceFps },
        },
      };
    }),

  clearSam2LivePreview: (clipId) =>
    set((state) => {
      const previous = state.sam2LivePreviewByClipId[clipId];
      if (!previous) return state;
      previous.bitmap.close();
      const next = { ...state.sam2LivePreviewByClipId };
      delete next[clipId];
      return { sam2LivePreviewByClipId: next };
    }),

  clearClipState: (clipId) =>
    set((state) => {
      const nextSelected = { ...state.selectedMaskByClipId };
      delete nextSelected[clipId];
      const nextSam2Editor = { ...state.sam2EditorMaskByClipId };
      delete nextSam2Editor[clipId];

      const previousPreview = state.sam2LivePreviewByClipId[clipId];
      if (previousPreview) {
        previousPreview.bitmap.close();
      }
      const nextLivePreview = { ...state.sam2LivePreviewByClipId };
      delete nextLivePreview[clipId];

      const shouldClearDraw = state.pendingDrawRequest?.clipId === clipId;
      const shouldClearInteraction = state.interactionContext?.clipId === clipId;

      return {
        selectedMaskByClipId: nextSelected,
        sam2EditorMaskByClipId: nextSam2Editor,
        sam2LivePreviewByClipId: nextLivePreview,
        pendingDrawRequest: shouldClearDraw ? null : state.pendingDrawRequest,
        interactionContext: shouldClearInteraction
          ? null
          : state.interactionContext,
      };
    }),
}));
