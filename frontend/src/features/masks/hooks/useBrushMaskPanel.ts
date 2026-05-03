import { useCallback, useSyncExternalStore } from "react";
import type { MaskTimelineClip } from "../../../types/TimelineTypes";
import {
  clearBrushBuffer,
  ensureBrushBuffer,
  getBrushBuffer,
  subscribeToBrushBuffer,
} from "../runtime/brushBufferRegistry";
import { flushBrushMaskCommit } from "../runtime/brushAssetSync";
import { useMaskViewStore } from "../store/useMaskViewStore";

export interface UseBrushMaskPanelResult {
  brushTool: "paint" | "erase" | "gizmo";
  setBrushTool: (tool: "paint" | "erase" | "gizmo") => void;
  brushRadius: number;
  setBrushRadius: (radius: number) => void;
  hasBrushAsset: boolean;
  clearBrush: () => void | Promise<void>;
}

interface UseBrushMaskPanelArgs {
  selectedClipId: string | null;
  selectedMaskId: string | null;
  selectedMask: MaskTimelineClip | null;
}

export function useBrushMaskPanel({
  selectedClipId,
  selectedMaskId,
  selectedMask,
}: UseBrushMaskPanelArgs): UseBrushMaskPanelResult {
  const brushTool = useMaskViewStore((state) => state.brushTool);
  const setBrushTool = useMaskViewStore((state) => state.setBrushTool);
  const brushRadius = useMaskViewStore((state) => state.brushRadius);
  const setBrushRadius = useMaskViewStore((state) => state.setBrushRadius);

  const selectedBrushMaskClipId =
    selectedMask?.maskType === "brush" ? selectedMask.id : null;
  const liveBrushPaintedBounds = useSyncExternalStore(
    useCallback(
      (listener) =>
        selectedBrushMaskClipId
          ? subscribeToBrushBuffer(selectedBrushMaskClipId, listener)
          : () => {},
      [selectedBrushMaskClipId],
    ),
    () =>
      selectedBrushMaskClipId
        ? getBrushBuffer(selectedBrushMaskClipId)?.paintedBounds ?? null
        : null,
    () => null,
  );

  const hasBrushAsset =
    selectedMask?.maskType === "brush" &&
    (!!selectedMask.brushMaskAssetId || !!liveBrushPaintedBounds);

  const clearBrush = useCallback(async () => {
    if (!selectedClipId || !selectedMaskId) return;
    if (!selectedMask || selectedMask.maskType !== "brush") {
      return;
    }

    ensureBrushBuffer(
      selectedMask.id,
      Math.max(1, selectedMask.maskParameters?.baseWidth ?? 1),
      Math.max(1, selectedMask.maskParameters?.baseHeight ?? 1),
    );
    clearBrushBuffer(selectedMask.id);
    await flushBrushMaskCommit(selectedMask.id);
  }, [selectedClipId, selectedMask, selectedMaskId]);

  return {
    brushTool,
    setBrushTool,
    brushRadius,
    setBrushRadius,
    hasBrushAsset,
    clearBrush,
  };
}
