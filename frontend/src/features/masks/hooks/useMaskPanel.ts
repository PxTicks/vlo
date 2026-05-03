import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  ClipMaskPoint,
  MaskActiveRange,
  MaskBooleanExpression,
  ClipMaskMode,
  ClipMaskType,
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../types/TimelineTypes";
import {
  resolveMaskCompositionAlgebra,
  type MaskCompositionAlgebra,
  type RangeMaskComponent,
} from "../../../types/Components";
import {
  useTimelineStore,
  useTimelineClip,
  parseMaskClipId,
  selectMaskClipsForParent,
} from "../../timeline";
import {
  useMaskViewStore,
} from "../store/useMaskViewStore";
import { createMask } from "../model/maskFactory";
import {
  getMaskCompositionComponent,
  resolveMaskBooleanExpression,
} from "../model/maskBooleanExpression";
import { useSam2MaskPanel } from "./useSam2MaskPanel";
import { useRangeMaskSelection } from "./useRangeMaskSelection";
import { useBrushMaskPanel } from "./useBrushMaskPanel";

export interface UseMaskPanelResult {
  selection: {
    selectedClipId: string | null;
    masks: MaskTimelineClip[];
    selectedMaskId: string | null;
    selectedMask: MaskTimelineClip | null;
    selectMask: (maskId: string) => void;
    duplicateMask: (maskId: string) => void;
    deleteMask: (maskId: string) => void;
    deleteSelectedMask: () => void;
  };
  panel: {
    addMenuAnchorEl: HTMLElement | null;
    isAddDisabled: boolean;
    addDisabledReason: string | null;
    setAddMenuAnchorEl: (anchor: HTMLElement | null) => void;
    requestDraw: (shape: ClipMaskType) => void;
  };
  mask: {
    maskBooleanExpression: MaskBooleanExpression | null;
    setMaskBooleanExpression: (
      expression: MaskBooleanExpression | null,
    ) => void;
    setMaskMode: (mode: ClipMaskMode) => void;
    setMaskName: (name: string) => void;
    maskInverted: boolean;
    setMaskInverted: (inverted: boolean) => void;
    maskCompositionAlgebra: MaskCompositionAlgebra;
    setMaskCompositionAlgebra: (algebra: MaskCompositionAlgebra) => void;
  };
  sam2: {
    sam2GrowAmount: number;
    setSam2GrowAmount: (amount: number) => void;
    sam2PointMode: "add" | "remove";
    setSam2PointMode: (mode: "add" | "remove") => void;
    sam2Points: ClipMaskPoint[];
    sam2CurrentFramePointsCount: number;
    isSam2EditorOpen: boolean;
    isSam2Available: boolean;
    isSam2Checking: boolean;
    sam2AvailabilityError: string | null;
    ensureSam2Available: () => Promise<boolean>;
    clearSam2Points: () => void;
    clearSam2CurrentFramePoints: () => void;
    generateSam2FramePreview: () => Promise<void>;
    isSam2FrameGenerating: boolean;
    sam2FramePreviewError: string | null;
    generateSam2Mask: () => Promise<void>;
    isSam2Generating: boolean;
    sam2GenerateError: string | null;
    isSam2Dirty: boolean;
    hasSam2MaskAsset: boolean;
  };
  brush: {
    brushTool: "paint" | "erase" | "gizmo";
    setBrushTool: (tool: "paint" | "erase" | "gizmo") => void;
    brushRadius: number;
    setBrushRadius: (radius: number) => void;
    hasBrushAsset: boolean;
    clearBrush: () => void | Promise<void>;
  };
  rangeMask: {
    rangeMaskComponents: RangeMaskComponent[];
    startAddRangeMask: () => void;
    startEditRangeMask: (rangeMaskId: string) => void;
    removeRangeMask: (rangeMaskId: string) => void;
    toggleRangeMaskActive: (rangeMaskId: string) => void;
    selectedMaskActiveRange: MaskActiveRange | null;
    startSetSelectedMaskActiveRange: () => void;
    clearSelectedMaskActiveRange: () => void;
  };
}

export function useMaskPanel(): UseMaskPanelResult {
  const [addMenuAnchorEl, setAddMenuAnchorEl] = useState<HTMLElement | null>(
    null,
  );

  const selectedClipId = useTimelineStore(
    (state) => state.selectedClipIds[0] ?? null,
  );
  const selectedClip = useTimelineClip(selectedClipId) ?? null;

  const updateClipMask = useTimelineStore((state) => state.updateClipMask);
  const duplicateClipMask = useTimelineStore((state) => state.duplicateClipMask);
  const removeClipMask = useTimelineStore((state) => state.removeClipMask);
  const addClipMask = useTimelineStore((state) => state.addClipMask);
  const setClipMaskBooleanExpression = useTimelineStore(
    (state) => state.setClipMaskBooleanExpression,
  );
  const setClipMaskCompositionAlgebra = useTimelineStore(
    (state) => state.setClipMaskCompositionAlgebra,
  );

  const selectedMaskId = useMaskViewStore((state) =>
    selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );
  const isMaskTabActive = useMaskViewStore((state) => state.isMaskTabActive);
  const setSelectedMask = useMaskViewStore((state) => state.setSelectedMask);
  const sam2PointMode = useMaskViewStore((state) => state.sam2PointMode);
  const setSam2PointMode = useMaskViewStore((state) => state.setSam2PointMode);

  // Read mask clips from the store via parent's mask clip components
  const masks = useTimelineStore(
    useShallow((state) =>
      selectedClipId
        ? selectMaskClipsForParent(state, selectedClipId)
        : [],
    ),
  );
  const maskBooleanExpression = useMemo(() => {
    if (!selectedClip || selectedClip.type === "mask") {
      return null;
    }

    return resolveMaskBooleanExpression(selectedClip, masks);
  }, [masks, selectedClip]);
  const maskCompositionAlgebra = useMemo(() => {
    if (!selectedClip || selectedClip.type === "mask") {
      return resolveMaskCompositionAlgebra(null);
    }

    return resolveMaskCompositionAlgebra(
      getMaskCompositionComponent(selectedClip)?.parameters,
    );
  }, [selectedClip]);

  const selectedMask = useMemo(() => {
    if (!selectedMaskId) return null;
    return (
      masks.find((m) => {
        const parsed = parseMaskClipId(m.id);
        return parsed?.maskId === selectedMaskId;
      }) ?? null
    );
  }, [masks, selectedMaskId]);

  const {
    sam2GrowAmount,
    setSam2GrowAmount,
    sam2Points,
    sam2CurrentFramePointsCount,
    isSam2EditorOpen,
    isSam2Available,
    isSam2Checking,
    sam2AvailabilityError,
    ensureSam2Available,
    clearSam2Points,
    clearSam2CurrentFramePoints,
    generateSam2FramePreview,
    isSam2FrameGenerating,
    sam2FramePreviewError,
    generateSam2Mask,
    isSam2Generating,
    sam2GenerateError,
    isSam2Dirty,
    hasSam2MaskAsset,
  } = useSam2MaskPanel({
    selectedClipId,
    selectedClip,
    selectedMaskId,
    selectedMask,
    isMaskTabActive,
    updateClipMask,
  });
  const {
    brushTool,
    setBrushTool,
    brushRadius,
    setBrushRadius,
    hasBrushAsset,
    clearBrush,
  } = useBrushMaskPanel({
    selectedClipId,
    selectedMaskId,
    selectedMask,
  });

  useEffect(() => {
    if (!selectedClipId) return;

    if (masks.length === 0) {
      setSelectedMask(selectedClipId, null);
      return;
    }

    const currentFound =
      selectedMaskId &&
      masks.some((m) => {
        const parsed = parseMaskClipId(m.id);
        return parsed?.maskId === selectedMaskId;
      });

    if (!currentFound) {
      const firstParsed = parseMaskClipId(masks[0].id);
      setSelectedMask(selectedClipId, firstParsed?.maskId ?? null);
    }
  }, [
    masks,
    selectedClipId,
    selectedMaskId,
    setSelectedMask,
  ]);

  const isMaskCompatibleClip =
    selectedClip !== null &&
    selectedClip.type !== "audio" &&
    selectedClip.type !== "mask";
  const isAddDisabled = !selectedClip || !isMaskCompatibleClip;
  const addDisabledReason = !selectedClip
    ? null
    : !isMaskCompatibleClip
      ? "Masks are only available for visual clips."
      : null;

  const requestDraw = useCallback(
    (shape: ClipMaskType) => {
      if (!selectedClipId || isAddDisabled) return;

      // Brush canvas dimensions are finalized lazily in the interaction
      // controller from the parent clip's content size on first paint, so
      // the placeholder here just needs to be > 0.
      const newMask = createMask(shape, {
        parameters:
          shape === "sam2"
            ? { baseWidth: 1, baseHeight: 1 }
            : shape === "brush"
              ? { baseWidth: 1, baseHeight: 1 }
              : { baseWidth: 200, baseHeight: 200 },
        maskPoints: shape === "sam2" ? [] : undefined,
      });

      addClipMask(selectedClipId, newMask);
      setSelectedMask(selectedClipId, newMask.id);

      setAddMenuAnchorEl(null);
    },
    [isAddDisabled, addClipMask, selectedClipId, setSelectedMask],
  );

  const selectMask = useCallback(
    (maskId: string) => {
      if (!selectedClipId) return;
      setSelectedMask(selectedClipId, maskId);
    },
    [selectedClipId, setSelectedMask],
  );

  const setMaskMode = useCallback(
    (mode: ClipMaskMode) => {
      if (!selectedClipId || !selectedMaskId) return;
      updateClipMask(selectedClipId, selectedMaskId, { maskMode: mode });
    },
    [selectedClipId, selectedMaskId, updateClipMask],
  );

  const setMaskName = useCallback(
    (name: string) => {
      if (!selectedClipId || !selectedMaskId) return;
      updateClipMask(selectedClipId, selectedMaskId, { name });
    },
    [selectedClipId, selectedMaskId, updateClipMask],
  );

  const setMaskInverted = useCallback(
    (inverted: boolean) => {
      if (!selectedClipId || !selectedMaskId) return;
      updateClipMask(selectedClipId, selectedMaskId, { maskInverted: inverted });
    },
    [selectedClipId, selectedMaskId, updateClipMask],
  );

  const maskInverted = selectedMask?.maskInverted ?? false;

  const standardSelectedClip =
    selectedClip && selectedClip.type !== "mask"
      ? (selectedClip as StandardTimelineClip)
      : null;
  const {
    rangeMaskComponents,
    startAddRangeMask,
    startEditRangeMask,
    removeRangeMask,
    toggleRangeMaskActive,
    selectedMaskActiveRange,
    startSetSelectedMaskActiveRange,
    clearSelectedMaskActiveRange,
  } = useRangeMaskSelection({
    selectedClipId,
    standardSelectedClip,
    selectedMaskId,
    selectedMask,
    updateClipMask,
  });

  const duplicateMask = useCallback(
    (maskId: string) => {
      if (!selectedClipId) return;
      const duplicatedMaskId = duplicateClipMask(selectedClipId, maskId);
      if (duplicatedMaskId) {
        setSelectedMask(selectedClipId, duplicatedMaskId);
      }
    },
    [duplicateClipMask, selectedClipId, setSelectedMask],
  );

  const deleteMask = useCallback(
    (maskId: string) => {
      if (!selectedClipId) return;

      const selectedIndex = masks.findIndex((m) => {
        const parsed = parseMaskClipId(m.id);
        return parsed?.maskId === maskId;
      });
      const fallbackMask =
        masks[selectedIndex + 1] ?? masks[selectedIndex - 1] ?? null;
      const fallbackId = fallbackMask
        ? (parseMaskClipId(fallbackMask.id)?.maskId ?? null)
        : null;

      removeClipMask(selectedClipId, maskId);
      if (selectedMaskId === maskId) {
        setSelectedMask(selectedClipId, fallbackId);
      }
    },
    [
      masks,
      removeClipMask,
      selectedClipId,
      selectedMaskId,
      setSelectedMask,
    ],
  );

  const deleteSelectedMask = useCallback(() => {
    if (!selectedMaskId) return;
    deleteMask(selectedMaskId);
  }, [deleteMask, selectedMaskId]);

  return {
    selection: {
      selectedClipId,
      masks,
      selectedMaskId,
      selectedMask,
      selectMask,
      duplicateMask,
      deleteMask,
      deleteSelectedMask,
    },
    panel: {
      addMenuAnchorEl,
      isAddDisabled,
      addDisabledReason,
      setAddMenuAnchorEl,
      requestDraw,
    },
    mask: {
      maskBooleanExpression,
      setMaskMode,
      setMaskBooleanExpression: (expression) => {
        if (!selectedClipId) return;
        setClipMaskBooleanExpression(selectedClipId, expression);
      },
      setMaskName,
      maskInverted,
      setMaskInverted,
      maskCompositionAlgebra,
      setMaskCompositionAlgebra: (algebra) => {
        if (!selectedClipId) return;
        setClipMaskCompositionAlgebra(selectedClipId, algebra);
      },
    },
    sam2: {
      sam2GrowAmount,
      setSam2GrowAmount,
      sam2PointMode,
      setSam2PointMode,
      sam2Points,
      sam2CurrentFramePointsCount,
      isSam2EditorOpen,
      isSam2Available,
      isSam2Checking,
      sam2AvailabilityError,
      ensureSam2Available,
      clearSam2Points,
      clearSam2CurrentFramePoints,
      generateSam2FramePreview,
      isSam2FrameGenerating,
      sam2FramePreviewError,
      generateSam2Mask,
      isSam2Generating,
      sam2GenerateError,
      isSam2Dirty,
      hasSam2MaskAsset,
    },
    brush: {
      brushTool,
      setBrushTool,
      brushRadius,
      setBrushRadius,
      hasBrushAsset,
      clearBrush,
    },
    rangeMask: {
      rangeMaskComponents,
      startAddRangeMask,
      startEditRangeMask,
      removeRangeMask,
      toggleRangeMaskActive,
      selectedMaskActiveRange,
      startSetSelectedMaskActiveRange,
      clearSelectedMaskActiveRange,
    },
  };
}
