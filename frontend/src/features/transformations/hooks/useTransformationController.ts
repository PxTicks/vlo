import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { ClipTransform, TimelineClip } from "../../../types/TimelineTypes";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import {
  getTimelineClips,
  getTimelinePresentationContext,
  getTimelineTracks,
  parseMaskClipId,
  setTimelineClipMaskCompositeTransforms,
  setTimelineClipTransforms,
  setTimelineClipTransformsAndShape,
  updateTimelineClipMask,
  useMaskClipsForParent,
  useSelectedTimelineClipIds,
  useTimelineClip,
} from "../../timeline/api";
import { useProjectStore } from "../../project/useProjectStore";
import {
  introducesTimelineClipPresentationCollision,
} from "../../timeline/utils/clipPresentation";
import { useMaskViewStore } from "../../masks/store/useMaskViewStore";
import { isDefaultTransform } from "../catalogue/TransformationRegistry";
import {
  presentationToClipSourceTime,
} from "../utils/clipTimeDomains";
import { computeCommitMutation } from "./controller/commitComputation";
import { computeBatchCommitMutations } from "./controller/batchCommitComputation";
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

interface ClipSplineEditTargetSnapshot {
  kind: "clip";
  clipId: string;
  transforms: ClipTransform[];
  shape: Pick<
    TimelineClip,
    | "timelineDuration"
    | "offset"
    | "transformedDuration"
    | "transformedOffset"
    | "croppedSourceDuration"
  >;
}

interface MaskSplineEditTargetSnapshot {
  kind: "mask";
  clipId: string;
  maskId: string;
  transforms: ClipTransform[];
}

interface MaskCompositeSplineEditTargetSnapshot {
  kind: "maskComposite";
  clipId: string;
  transforms: ClipTransform[];
}

type SplineEditTargetSnapshot =
  | ClipSplineEditTargetSnapshot
  | MaskSplineEditTargetSnapshot
  | MaskCompositeSplineEditTargetSnapshot;

function isSplineEditTargetSnapshot(
  value: unknown,
): value is SplineEditTargetSnapshot {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }

  const candidate = value as { kind?: unknown };
  return (
    candidate.kind === "clip" ||
    candidate.kind === "mask" ||
    candidate.kind === "maskComposite"
  );
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
  const selectedClipIds = useSelectedTimelineClipIds();
  const activeClip = useTimelineClip(selectedClipIds[0]) ?? null;
  const selectedClipId = activeClip ? selectedClipIds[0] : undefined;
  const selectedMaskId = useMaskViewStore((state) =>
    (targetMode === "mask" || targetMode === "auto") && selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );

  // Resolve mask clip from the store
  const parentMaskClips = useMaskClipsForParent(selectedClipId);
  const selectedMaskClip = useMemo(
    () =>
      targetMode === "clip" ||
      targetMode === "maskComposite" ||
      !selectedClipId ||
      !selectedMaskId
        ? undefined
        : parentMaskClips.find(
            (c) => parseMaskClipId(c.id)?.maskId === selectedMaskId,
          ),
    [parentMaskClips, selectedClipId, selectedMaskId, targetMode],
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
      const didTransformedOffsetChange =
        shapeUpdate.transformedOffset !== undefined &&
        shapeUpdate.transformedOffset !== clip.transformedOffset;

      return didTimelineDurationChange ||
        didTransformedDurationChange ||
        didTransformedOffsetChange
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
        const clip = currentTarget.timelineClip;
        const shapeUpdate = getChangedClipShapeUpdate(clip, nextTransforms);
        if (shapeUpdate) {
          const allClips = getTimelineClips();
          const tracks = getTimelineTracks();
          // Single, presentation-aware, frame-quantized collision gate — the
          // same grid the renderer selects on. (The former raw hasAnyCollision
          // pre-check is dropped: it tested stored timing and so disagreed with
          // the warped presentation footprint under adjustment speed ramps.)
          if (
            introducesTimelineClipPresentationCollision(
              tracks,
              allClips,
              useProjectStore.getState().config.fps,
              {
                clipId: clip.id,
                transformations: nextTransforms,
                timelineDuration: shapeUpdate.timelineDuration,
                transformedDuration: shapeUpdate.transformedDuration,
                transformedOffset: shapeUpdate.transformedOffset,
              },
            )
          ) {
            return;
          }
          setTimelineClipTransformsAndShape(
            currentTarget.clipId,
            nextTransforms,
            shapeUpdate,
          );
          return;
        }

        setTimelineClipTransforms(currentTarget.clipId, nextTransforms);
        return;
      }

      if (currentTarget.kind === "maskComposite") {
        setTimelineClipMaskCompositeTransforms(
          currentTarget.clipId,
          nextTransforms,
        );
        return;
      }

      if (!currentTarget.maskId) return;
      // For mask targets, set the mask-local transforms via updateClipMask
      updateTimelineClipMask(currentTarget.clipId, currentTarget.maskId, {
        transformations: nextTransforms,
      });
    },
    [
      getChangedClipShapeUpdate,
    ],
  );

  const captureActiveTargetSnapshot =
    useCallback((): SplineEditTargetSnapshot | null => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget) {
        return null;
      }

      if (currentTarget.kind === "clip") {
        return {
          kind: "clip",
          clipId: currentTarget.clipId,
          transforms: structuredClone(currentTarget.transforms),
          shape: {
            timelineDuration: currentTarget.timelineClip.timelineDuration,
            offset: currentTarget.timelineClip.offset,
            transformedDuration: currentTarget.timelineClip.transformedDuration,
            transformedOffset: currentTarget.timelineClip.transformedOffset,
            croppedSourceDuration:
              currentTarget.timelineClip.croppedSourceDuration,
          },
        };
      }

      if (currentTarget.kind === "mask") {
        if (!currentTarget.maskId) {
          return null;
        }

        return {
          kind: "mask",
          clipId: currentTarget.clipId,
          maskId: currentTarget.maskId,
          transforms: structuredClone(currentTarget.transforms),
        };
      }

      return {
        kind: "maskComposite",
        clipId: currentTarget.clipId,
        transforms: structuredClone(currentTarget.transforms),
      };
    }, []);

  const restoreTargetSnapshot = useCallback(
    (snapshot: unknown) => {
      if (!isSplineEditTargetSnapshot(snapshot)) {
        return;
      }

      if (snapshot.kind === "clip") {
        setTimelineClipTransformsAndShape(
          snapshot.clipId,
          structuredClone(snapshot.transforms),
          snapshot.shape,
        );
        return;
      }

      if (snapshot.kind === "mask") {
        updateTimelineClipMask(snapshot.clipId, snapshot.maskId, {
          transformations: structuredClone(snapshot.transforms),
        });
        return;
      }

      setTimelineClipMaskCompositeTransforms(
        snapshot.clipId,
        structuredClone(snapshot.transforms),
      );
    },
    [],
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
      const activeClip = currentTarget.timelineClip;

      // Resolve the keyframe's source-media time (in project ticks) through any
      // adjustment-layer retiming, matching the frame shown by the viewer.
      let keyframeSourceTimeTicks: number | undefined;
      if (activeClip) {
        const presentationTick = Math.max(
          activeClip.start,
          Math.min(
            playbackClock.time,
            activeClip.start + activeClip.timelineDuration,
          ),
        );
        keyframeSourceTimeTicks = presentationToClipSourceTime(
          getTimelinePresentationContext(),
          activeClip,
          presentationTick,
        );
      }

      const commit = computeCommitMutation({
        groupId,
        controlName,
        value,
        transformId,
        transforms: currentTransforms,
        activeClip,
        playheadTicks: playbackClock.time,
        pointEpsilonTicks: POINT_EPSILON_TICKS,
        keyframeSourceTimeTicks,
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

  const handleCommitMany = useCallback(
    (
      groupId: string,
      values: Readonly<Record<string, unknown>>,
      transformId?: string,
    ) => {
      const currentTarget = activeTargetRef.current;
      if (!currentTarget || Object.keys(values).length === 0) return;

      const activeClip = currentTarget.timelineClip;
      const presentationTick = Math.max(
        activeClip.start,
        Math.min(
          playbackClock.time,
          activeClip.start + activeClip.timelineDuration,
        ),
      );
      const keyframeSourceTimeTicks = presentationToClipSourceTime(
        getTimelinePresentationContext(),
        activeClip,
        presentationTick,
      );

      applyTargetTransforms(
        computeBatchCommitMutations({
          groupId,
          values,
          transformId,
          transforms: activeTransformsRef.current,
          activeClip,
          playheadTicks: playbackClock.time,
          pointEpsilonTicks: POINT_EPSILON_TICKS,
          keyframeSourceTimeTicks,
        }),
      );
    },
    [applyTargetTransforms],
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
    handleCommitMany,
    handleReorder,
    captureActiveTargetSnapshot,
    restoreTargetSnapshot,
  };
}
