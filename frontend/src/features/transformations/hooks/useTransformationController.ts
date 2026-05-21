import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { playbackClock } from "../../player/services/PlaybackClock";
import {
  selectTimelineClipById,
  useTimelineStore,
  parseMaskClipId,
  selectMaskClipsForParent,
} from "../../timeline";
import { useMaskViewStore } from "../../masks/store/useMaskViewStore";
import { isDefaultTransform } from "../catalogue/TransformationRegistry";
import { computeCommitMutation } from "./controller/commitComputation";
import { computeSpeedShapeUpdateForTransforms } from "./controller/speedDuration";
import { createAddTransform } from "./controller/transformFactory";
import {
  insertTransformRespectingDefaultOrder,
  reorderDynamicTransforms,
} from "./controller/transformOrdering";

const EMPTY_TRANSFORMS: ClipTransform[] = [];
const POINT_EPSILON_TICKS = 1;

const INHERITED_TRANSFORM_TYPES = new Set(["speed"]);

type EnableTarget = { transformId: string } | { transformType: string };

interface UseTransformationControllerOptions {
  target?: "clip" | "mask" | "maskComposite" | "auto";
}

interface ActiveTransformTarget {
  kind: "clip" | "mask" | "maskComposite";
  clipId: string;
  maskId?: string;
  contextId: string;
  timelineClip: TimelineClip;
  transforms: ClipTransform[];
}

/** Get mask-local transforms (excluding inherited speed transforms). */
function getMaskLocalTransforms(maskClip: TimelineClip): ClipTransform[] {
  return (maskClip.transformations || []).filter(
    (t) => !INHERITED_TRANSFORM_TYPES.has(t.type),
  );
}

export function useTransformationController(
  options: UseTransformationControllerOptions = {},
) {
  const targetMode = options.target ?? "clip";
  const {
    selectedClipIds,
    setClipTransforms,
    setClipTransformsAndShape,
    setClipMaskCompositeTransforms,
    updateClipMask,
    activeClip,
  } = useTimelineStore(
    useShallow((state) => {
      const firstId = state.selectedClipIds[0];
      const clip = selectTimelineClipById(state, firstId);
      return {
        selectedClipIds: state.selectedClipIds,
        setClipTransforms: state.setClipTransforms,
        setClipTransformsAndShape: state.setClipTransformsAndShape,
        setClipMaskCompositeTransforms: state.setClipMaskCompositeTransforms,
        updateClipMask: state.updateClipMask,
        activeClip: clip,
      };
    }),
  );

  const selectedClipId = activeClip ? selectedClipIds[0] : undefined;
  const selectedMaskId = useMaskViewStore((state) =>
    (targetMode === "mask" || targetMode === "auto") && selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );

  // Resolve mask clip from the store
  const selectedMaskClip = useTimelineStore(
    useShallow((state) =>
      targetMode === "clip" ||
      targetMode === "maskComposite" ||
      !selectedClipId ||
      !selectedMaskId
        ? undefined
        : selectMaskClipsForParent(state, selectedClipId).find(
            (c) => parseMaskClipId(c.id)?.maskId === selectedMaskId,
          ),
    ),
  );

  const activeTarget = useMemo<ActiveTransformTarget | null>(() => {
    if (!activeClip) return null;

    if (targetMode === "maskComposite") {
      const compositionComponent =
        activeClip.type !== "mask"
          ? (activeClip.components ?? []).find(
              (component) => component.type === "mask_composition",
            )
          : undefined;
      return {
        kind: "maskComposite",
        clipId: activeClip.id,
        contextId: `${activeClip.id}::mask-composite`,
        timelineClip: activeClip,
        transforms:
          compositionComponent?.type === "mask_composition"
            ? compositionComponent.parameters.compositeTransformations
            : EMPTY_TRANSFORMS,
      };
    }

    if (targetMode !== "clip" && selectedMaskClip) {
      const parsed = parseMaskClipId(selectedMaskClip.id);
      return {
        kind: "mask",
        clipId: activeClip.id,
        maskId: parsed?.maskId,
        contextId: selectedMaskClip.id,
        timelineClip: selectedMaskClip,
        transforms: getMaskLocalTransforms(selectedMaskClip),
      };
    }

    if (targetMode === "mask") {
      return null;
    }

    return {
      kind: "clip",
      clipId: activeClip.id,
      contextId: activeClip.id,
      timelineClip: activeClip,
      transforms: activeClip.transformations || EMPTY_TRANSFORMS,
    };
  }, [activeClip, selectedMaskClip, targetMode]);

  const activeTransforms = activeTarget?.transforms ?? EMPTY_TRANSFORMS;
  const activeTimelineClip = activeTarget?.timelineClip;
  const activeContextId = activeTarget?.contextId;
  const activeClipDuration = activeTimelineClip?.timelineDuration;
  const activeClipSourceDuration =
    activeTimelineClip?.sourceDuration ?? undefined;

  const activeTransformsRef = useRef(activeTransforms);
  useEffect(() => {
    activeTransformsRef.current = activeTransforms;
  }, [activeTransforms]);

  const activeTargetRef = useRef(activeTarget);
  useEffect(() => {
    activeTargetRef.current = activeTarget;
  }, [activeTarget]);

  const getChangedClipShapeUpdate = useCallback(
    (clip: TimelineClip, nextTransforms: ClipTransform[]) => {
      const shapeUpdate = computeSpeedShapeUpdateForTransforms({
        clip,
        nextTransforms,
      });
      if (!shapeUpdate) {
        return null;
      }

      const didTimelineDurationChange =
        shapeUpdate.timelineDuration !== clip.timelineDuration;
      const didTransformedDurationChange =
        shapeUpdate.transformedDuration !== undefined &&
        shapeUpdate.transformedDuration !== clip.transformedDuration;

      return didTimelineDurationChange || didTransformedDurationChange
        ? shapeUpdate
        : null;
    },
    [],
  );

  const applyTargetTransforms = useCallback(
    (nextTransforms: ClipTransform[]) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      if (currentTarget.kind === "clip") {
        const shapeUpdate = getChangedClipShapeUpdate(
          currentTarget.timelineClip,
          nextTransforms,
        );
        if (shapeUpdate) {
          setClipTransformsAndShape(
            currentTarget.clipId,
            nextTransforms,
            shapeUpdate,
          );
          return;
        }

        setClipTransforms(currentTarget.clipId, nextTransforms);
        return;
      }

      if (currentTarget.kind === "maskComposite") {
        setClipMaskCompositeTransforms(currentTarget.clipId, nextTransforms);
        return;
      }

      if (!currentTarget.maskId) return;
      // For mask targets, set the mask-local transforms via updateClipMask
      updateClipMask(currentTarget.clipId, currentTarget.maskId, {
        transformations: nextTransforms,
      });
    },
    [
      getChangedClipShapeUpdate,
      setClipMaskCompositeTransforms,
      setClipTransforms,
      setClipTransformsAndShape,
      updateClipMask,
    ],
  );

  const updateTargetTransform = useCallback(
    (
      transformId: string,
      updates: Partial<Omit<ClipTransform, "id" | "type">>,
    ) => {
      const nextTransforms = activeTransformsRef.current.map((transform) =>
        transform.id === transformId ? { ...transform, ...updates } : transform,
      );
      applyTargetTransforms(nextTransforms);
    },
    [applyTargetTransforms],
  );

  const applyEnabledState = useCallback(
    (targets: EnableTarget[], enabled: boolean) => {
      if (targets.length === 0) return;
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      let nextTransforms = [...activeTransformsRef.current];
      let didChange = false;

      targets.forEach((target) => {
        const index =
          "transformId" in target
            ? nextTransforms.findIndex(
                (transform) => transform.id === target.transformId,
              )
            : nextTransforms.findIndex(
                (transform) => transform.type === target.transformType,
              );

        if (index !== -1) {
          const existingTransform = nextTransforms[index];
          if (existingTransform.isEnabled === enabled) return;

          nextTransforms[index] = { ...existingTransform, isEnabled: enabled };
          didChange = true;
          return;
        }

        // Missing default transform behaves as implicitly enabled.
        // To explicitly disable, we materialize it with default params.
        if (enabled || "transformId" in target) return;

        const created = createAddTransform(target.transformType, false, false);
        if (!created) return;

        nextTransforms = insertTransformRespectingDefaultOrder(
          nextTransforms,
          created,
        );
        didChange = true;
      });

      if (!didChange) return;

      applyTargetTransforms(nextTransforms);
    },
    [applyTargetTransforms],
  );

  const handleAddTransform = useCallback(
    (typeOrFilterName: string, isFilter = false) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      const newTransform = createAddTransform(typeOrFilterName, isFilter);
      if (!newTransform) return;

      applyTargetTransforms(
        insertTransformRespectingDefaultOrder(
          activeTransformsRef.current,
          newTransform,
        ),
      );
    },
    [applyTargetTransforms],
  );

  const handleRemoveTransform = useCallback(
    (transformId: string) => {
      applyTargetTransforms(
        activeTransformsRef.current.filter(
          (transform) => transform.id !== transformId,
        ),
      );
    },
    [applyTargetTransforms],
  );

  const handleSetTransformEnabled = useCallback(
    (transformId: string, enabled: boolean) => {
      applyEnabledState([{ transformId }], enabled);
    },
    [applyEnabledState],
  );

  const handleSetDefaultGroupsEnabled = useCallback(
    (groupIds: string[], enabled: boolean) => {
      applyEnabledState(
        groupIds.map((groupId) => ({ transformType: groupId })),
        enabled,
      );
    },
    [applyEnabledState],
  );

  const handleCommit = useCallback(
    (
      groupId: string,
      controlName: string,
      value: unknown,
      transformId?: string,
    ) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      const currentTransforms = activeTransformsRef.current;
      const commit = computeCommitMutation({
        groupId,
        controlName,
        value,
        transformId,
        transforms: currentTransforms,
        activeClip: currentTarget.timelineClip,
        playheadTicks: playbackClock.time,
        pointEpsilonTicks: POINT_EPSILON_TICKS,
      });

      if (commit.mode === "update") {
        updateTargetTransform(commit.existingTransform.id, {
          parameters: commit.parameters,
          ...(commit.keyframeTimes !== undefined
            ? { keyframeTimes: commit.keyframeTimes }
            : {}),
        });
      } else {
        const nextTransforms = isDefaultTransform(commit.createdTransform.type)
          ? insertTransformRespectingDefaultOrder(
              currentTransforms,
              commit.createdTransform,
            )
          : [...currentTransforms, commit.createdTransform];
        applyTargetTransforms(nextTransforms);
      }
    },
    [applyTargetTransforms, updateTargetTransform],
  );

  const handleReorder = useCallback(
    (activeId: UniqueIdentifier, overId: UniqueIdentifier) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) return;

      const reordered = reorderDynamicTransforms(
        activeTransformsRef.current,
        activeId,
        overId,
      );
      if (!reordered) return;
      applyTargetTransforms(reordered);
    },
    [applyTargetTransforms],
  );

  return {
    selectedClipId: activeTarget?.clipId,
    activeTargetKind: activeTarget?.kind ?? null,
    activeContextId,
    activeTransforms,
    activeTimelineClip,
    activeClipDuration,
    activeClipSourceDuration,
    setActiveTransforms: applyTargetTransforms,
    updateActiveTransform: updateTargetTransform,
    handleAddTransform,
    handleRemoveTransform,
    handleSetTransformEnabled,
    handleSetDefaultGroupsEnabled,
    handleCommit,
    handleReorder,
  };
}
