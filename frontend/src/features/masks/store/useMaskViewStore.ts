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

export interface MaskPreviewTarget {
  clipId: string;
  maskId: string;
}

export interface Sam2LivePreview {
  maskId: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  frameIndex: number;
  sourceFps: number;
  /**
   * Point-set hash this single-frame preview was generated from. The overlay
   * only shows the preview while this matches the mask's current points; any
   * point edit invalidates it and the base (generated-mask) layer takes over.
   */
  pointsHash: string;
}

export type Sam2PointMode = "add" | "remove";
export type BrushTool = "paint" | "erase" | "gizmo";
export const DEFAULT_BRUSH_RADIUS = 32;
export const MIN_BRUSH_RADIUS = 2;
export const MAX_BRUSH_RADIUS = 256;

interface MaskViewState {
  selectedMaskByClipId: Record<string, string | undefined>;
  sam2EditorMaskByClipId: Record<string, string | undefined>;
  isMaskTabActive: boolean;
  pendingDrawRequest: PendingMaskDrawRequest | null;
  interactionContext: MaskInteractionContext | null;
  sam2LivePreviewByClipId: Record<string, Sam2LivePreview | undefined>;
  sam2PointMode: Sam2PointMode;
  brushTool: BrushTool;
  brushRadius: number;
  /**
   * Transient, single-target mask preview. Identifies the one mask whose bounds
   * are being inspected in isolation (equation bypassed). Never persisted — it
   * is only ever set while an individual mask panel is active and intentionally
   * toggled on, and is cleared the moment that focus is lost.
   */
  maskPreviewTarget: MaskPreviewTarget | null;
  setSelectedMask: (clipId: string, maskId: string | null) => void;
  setSam2EditorMask: (clipId: string, maskId: string | null) => void;
  setMaskTabActive: (isActive: boolean) => void;
  requestMaskDraw: (clipId: string, shape: ClipMaskType) => void;
  clearPendingDraw: () => void;
  setInteractionContext: (context: MaskInteractionContext | null) => void;
  setSam2PointMode: (mode: Sam2PointMode) => void;
  setBrushTool: (tool: BrushTool) => void;
  setBrushRadius: (radius: number) => void;
  setSam2LivePreview: (
    clipId: string,
    maskId: string,
    bitmap: ImageBitmap,
    width: number,
    height: number,
    frameIndex: number,
    sourceFps: number,
    pointsHash: string,
  ) => void;
  clearSam2LivePreview: (clipId: string) => void;
  setMaskPreviewTarget: (clipId: string, maskId: string) => void;
  clearMaskPreviewTarget: () => void;
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
  brushTool: "gizmo",
  brushRadius: DEFAULT_BRUSH_RADIUS,
  maskPreviewTarget: null,

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

  setBrushTool: (tool) => set({ brushTool: tool }),

  setBrushRadius: (radius) =>
    set({
      brushRadius: Math.max(
        MIN_BRUSH_RADIUS,
        Math.min(MAX_BRUSH_RADIUS, Math.round(radius)),
      ),
    }),

  setSam2LivePreview: (
    clipId,
    maskId,
    bitmap,
    width,
    height,
    frameIndex,
    sourceFps,
    pointsHash,
  ) =>
    set((state) => {
      const previous = state.sam2LivePreviewByClipId[clipId];
      if (previous) {
        previous.bitmap.close();
      }
      return {
        sam2LivePreviewByClipId: {
          ...state.sam2LivePreviewByClipId,
          [clipId]: {
            maskId,
            bitmap,
            width,
            height,
            frameIndex,
            sourceFps,
            pointsHash,
          },
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

  setMaskPreviewTarget: (clipId, maskId) =>
    set((state) => {
      const current = state.maskPreviewTarget;
      if (current && current.clipId === clipId && current.maskId === maskId) {
        return state;
      }
      return { maskPreviewTarget: { clipId, maskId } };
    }),

  clearMaskPreviewTarget: () =>
    set((state) =>
      state.maskPreviewTarget === null ? state : { maskPreviewTarget: null },
    ),

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
      const shouldClearPreviewTarget =
        state.maskPreviewTarget?.clipId === clipId;

      return {
        selectedMaskByClipId: nextSelected,
        sam2EditorMaskByClipId: nextSam2Editor,
        sam2LivePreviewByClipId: nextLivePreview,
        pendingDrawRequest: shouldClearDraw ? null : state.pendingDrawRequest,
        interactionContext: shouldClearInteraction
          ? null
          : state.interactionContext,
        maskPreviewTarget: shouldClearPreviewTarget
          ? null
          : state.maskPreviewTarget,
      };
    }),
}));
