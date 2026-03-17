import { useEffect, useMemo, useRef } from "react";
import type { Application, Container, FederatedPointerEvent, Sprite } from "pixi.js";
import { getTimelineClipById, useTimelineStore } from "../../../timeline";
import { usePlayerStore } from "../../usePlayerStore";
import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import type {
  PositionTransform,
  RotationTransform,
  ScaleTransform,
} from "../../../transformations";
import {
  computeCommitMutation,
  createAddTransform,
  getTransformInputTimeAtVisualOffset,
  insertTransformRespectingDefaultOrder,
  liveParamStore,
  resolveScalar,
} from "../../../transformations";
import { playbackClock } from "../../services/PlaybackClock";
import {
  commitTransformControl,
  hasDragMovement,
} from "./transformInteraction";
import {
  bindStagePointerListeners,
  toViewportLocal,
  unbindStagePointerListeners,
} from "./pointerStage";
import {
  computeHandleScale,
  getAngleFromPoint,
} from "./layoutInteractionMath";

const POINT_EPSILON_TICKS = 1;
const DRAG_MOVE_EPSILON = 0.01;

type InteractionMode = "translate" | "scale" | "rotate";

interface InteractionState {
  active: boolean;
  clipId: string | null;
  mode: InteractionMode | null;
  handle: string | null;
  startLocal: { x: number; y: number };
  startSprite: { x: number; y: number };
  startVisualScale: { x: number; y: number };
  startVisualRotation: number;
  startParams: { x: number; y: number; angle: number };
  baseScale: { x: number; y: number };
  initialAngle: number;
  transformIds: { position: string | null; scale: string | null; rotation: string | null };
  lastPositionParams: { x: number; y: number } | null;
  lastScaleParams: { x: number; y: number } | null;
  lastRotationParam: number | null;
  didMove: boolean;
}

function createInitialInteractionState(): InteractionState {
  return {
    active: false,
    clipId: null,
    mode: null,
    handle: null,
    startLocal: { x: 0, y: 0 },
    startSprite: { x: 0, y: 0 },
    startVisualScale: { x: 1, y: 1 },
    startVisualRotation: 0,
    startParams: { x: 0, y: 0, angle: 0 },
    baseScale: { x: 1, y: 1 },
    initialAngle: 0,
    transformIds: { position: null, scale: null, rotation: null },
    lastPositionParams: null,
    lastScaleParams: null,
    lastRotationParam: null,
    didMove: false,
  };
}

export interface TransformInteractionHandlers {
  onSpritePointerDown: (e: FederatedPointerEvent) => void;
  onHandlePointerDown: (e: FederatedPointerEvent, key: string) => void;
}

export function useTransformInteractionController(
  sprite: Sprite | null,
  activeClipRef: React.MutableRefObject<TimelineClip | null>,
  app: Application | null,
  viewport: Container | null,
): TransformInteractionHandlers {
  const setIsPlaying = usePlayerStore((state) => state.setIsPlaying);
  const addClipTransform = useTimelineStore((state) => state.addClipTransform);
  const updateClipTransform = useTimelineStore((state) => state.updateClipTransform);
  const setClipTransforms = useTimelineStore((state) => state.setClipTransforms);
  const selectClip = useTimelineStore((state) => state.selectClip);

  const interactionRef = useRef<InteractionState>(createInitialInteractionState());

  const handlers = useMemo(() => {
    const findClipById = (clipId: string): TimelineClip | null => {
      const clip = getTimelineClipById(clipId);
      return clip ?? null;
    };

    const resetInteractionState = () => {
      const current = interactionRef.current;
      current.active = false;
      current.clipId = null;
      current.mode = null;
      current.handle = null;
      current.lastPositionParams = null;
      current.lastScaleParams = null;
      current.lastRotationParam = null;
      current.didMove = false;
    };

    const applyCommit = (
      clip: TimelineClip,
      transforms: ClipTransform[],
      groupId: "position" | "scale" | "rotation",
      controlName: "x" | "y" | "angle",
      value: number,
      transformId?: string,
    ): { transformId: string; nextTransforms: ClipTransform[] } | null => {
      return commitTransformControl({
        clip,
        transforms,
        groupId,
        controlName,
        value,
        transformId,
        playheadTicks: playbackClock.time,
        pointEpsilonTicks: POINT_EPSILON_TICKS,
        actions: { addClipTransform, setClipTransforms, updateClipTransform },
      });
    };

    const ensurePositionTransformForLive = (clipId: string): string | null => {
      const clip = findClipById(clipId);
      if (!clip) return null;

      const existing = (clip.transformations || []).find(
        (transform) => transform.type === "position",
      );
      if (existing) {
        return existing.id;
      }

      const commit = computeCommitMutation({
        groupId: "position",
        controlName: "x",
        value: interactionRef.current.startParams.x,
        transforms: clip.transformations || [],
        activeClip: clip,
        playheadTicks: playbackClock.time,
        pointEpsilonTicks: POINT_EPSILON_TICKS,
      });
      if (commit.mode !== "create") {
        return commit.existingTransform.id;
      }

      const orderedTransforms = insertTransformRespectingDefaultOrder(
        clip.transformations || [],
        commit.createdTransform,
      );
      setClipTransforms(clip.id, orderedTransforms);
      return commit.createdTransform.id;
    };

    const computeScaleDrag = (global: { x: number; y: number }) => {
      if (!viewport || !sprite) return null;
      const current = interactionRef.current;
      const localPos = toViewportLocal(viewport, global);

      const dx = localPos.x - current.startLocal.x;
      const dy = localPos.y - current.startLocal.y;
      const scaleDrag = computeHandleScale({
        handle: current.handle,
        startScale: current.startVisualScale,
        pointerDelta: { x: dx, y: dy },
        rotation: current.startVisualRotation,
        baseSize: {
          width: sprite.texture.width || 1,
          height: sprite.texture.height || 1,
        },
      });

      const newVisualScaleX = scaleDrag.scale.x;
      let newVisualScaleY = scaleDrag.scale.y;

      const newParamX = newVisualScaleX / current.baseScale.x;
      let newParamY = newVisualScaleY / current.baseScale.y;

      const isCorner = current.handle && current.handle.length === 2;
      if (isCorner) {
        const ratio = current.startParams.x / current.startParams.y;
        if (Math.abs(current.startParams.x) > 0.0001 && Math.abs(ratio) > 0.0001) {
          newParamY = newParamX / ratio;
          newVisualScaleY = newParamY * current.baseScale.y;
        }
      }

      return {
        localDx: scaleDrag.localDelta.x,
        localDy: scaleDrag.localDelta.y,
        newParamX,
        newParamY,
        newVisualScaleX,
        newVisualScaleY,
      };
    };

    const computeRotationDrag = (global: { x: number; y: number }) => {
      if (!sprite) return null;

      const spriteGlobal = sprite.getGlobalPosition();
      const currentAngle = getAngleFromPoint(global, spriteGlobal);
      const deltaAngle = currentAngle - interactionRef.current.initialAngle;

      return {
        deltaAngle,
        newVisualRotation: interactionRef.current.startVisualRotation + deltaAngle,
        newParamAngle: interactionRef.current.startParams.angle + deltaAngle,
      };
    };

    const unbindStageListeners = () =>
      unbindStagePointerListeners(app, onPointerMove, onPointerUp);

    const bindStageListeners = () =>
      bindStagePointerListeners(app, onPointerMove, onPointerUp);

    function onPointerMove(e: FederatedPointerEvent) {
      const current = interactionRef.current;
      if (!current.active || !current.clipId || !viewport || !sprite) return;

      if (current.mode === "translate") {
        const localPos = toViewportLocal(viewport, e.global);
        const deltaX = localPos.x - current.startLocal.x;
        const deltaY = localPos.y - current.startLocal.y;

        const newX = current.startParams.x + deltaX;
        const newY = current.startParams.y + deltaY;
        current.lastPositionParams = { x: newX, y: newY };

        if (hasDragMovement(DRAG_MOVE_EPSILON, deltaX, deltaY)) {
          current.didMove = true;
        }

        if (current.didMove && !current.transformIds.position) {
          const materializedTransformId = ensurePositionTransformForLive(current.clipId);
          if (materializedTransformId) {
            current.transformIds.position = materializedTransformId;
          }
        }

        sprite.position.set(
          current.startSprite.x + deltaX,
          current.startSprite.y + deltaY,
        );

        if (current.transformIds.position) {
          liveParamStore.notify(current.transformIds.position, "x", newX);
          liveParamStore.notify(current.transformIds.position, "y", newY);
        }
        return;
      }

      if (current.mode === "scale") {
        const scaleDrag = computeScaleDrag(e.global);
        if (!scaleDrag) return;

        sprite.scale.set(scaleDrag.newVisualScaleX, scaleDrag.newVisualScaleY);
        current.lastScaleParams = { x: scaleDrag.newParamX, y: scaleDrag.newParamY };

        if (
          hasDragMovement(
            DRAG_MOVE_EPSILON,
            scaleDrag.localDx,
            scaleDrag.localDy,
          )
        ) {
          current.didMove = true;
        }

        if (current.transformIds.scale) {
          liveParamStore.notify(current.transformIds.scale, "x", scaleDrag.newParamX);
          liveParamStore.notify(current.transformIds.scale, "y", scaleDrag.newParamY);
        }
        return;
      }

      if (current.mode === "rotate") {
        const rotationDrag = computeRotationDrag(e.global);
        if (!rotationDrag) return;

        // eslint-disable-next-line react-hooks/immutability
        sprite.rotation = rotationDrag.newVisualRotation;
        current.lastRotationParam = rotationDrag.newParamAngle;

        if (hasDragMovement(DRAG_MOVE_EPSILON, rotationDrag.deltaAngle)) {
          current.didMove = true;
        }

        if (current.transformIds.rotation) {
          liveParamStore.notify(
            current.transformIds.rotation,
            "angle",
            rotationDrag.newParamAngle,
          );
        }
      }
    }

    function onPointerUp(e?: FederatedPointerEvent) {
      const current = interactionRef.current;
      if (!current.active) return;

      if (current.clipId && current.didMove) {
        const latestClip = findClipById(current.clipId);
        if (latestClip) {
          let nextTransforms = [...(latestClip.transformations || [])];

          if (current.mode === "translate") {
            let finalPosition = current.lastPositionParams;
            if (e && viewport) {
              const localPos = toViewportLocal(viewport, e.global);
              finalPosition = {
                x: current.startParams.x + (localPos.x - current.startLocal.x),
                y: current.startParams.y + (localPos.y - current.startLocal.y),
              };
            }

            if (finalPosition) {
              const xCommit = applyCommit(
                latestClip,
                nextTransforms,
                "position",
                "x",
                finalPosition.x,
                current.transformIds.position ?? undefined,
              );
              if (xCommit) {
                nextTransforms = xCommit.nextTransforms;
                current.transformIds.position = xCommit.transformId;
              }

              const yCommit = applyCommit(
                latestClip,
                nextTransforms,
                "position",
                "y",
                finalPosition.y,
                current.transformIds.position ?? undefined,
              );
              if (yCommit) {
                current.transformIds.position = yCommit.transformId;
              }
            }
          } else if (current.mode === "scale") {
            const finalScale = e && viewport ? computeScaleDrag(e.global) : null;
            const finalScaleParams =
              finalScale !== null
                ? { x: finalScale.newParamX, y: finalScale.newParamY }
                : current.lastScaleParams;

            if (finalScaleParams) {
              const xCommit = applyCommit(
                latestClip,
                nextTransforms,
                "scale",
                "x",
                finalScaleParams.x,
                current.transformIds.scale ?? undefined,
              );
              if (xCommit) {
                nextTransforms = xCommit.nextTransforms;
                current.transformIds.scale = xCommit.transformId;
              }

              const yCommit = applyCommit(
                latestClip,
                nextTransforms,
                "scale",
                "y",
                finalScaleParams.y,
                current.transformIds.scale ?? undefined,
              );
              if (yCommit) {
                current.transformIds.scale = yCommit.transformId;
              }
            }
          } else if (current.mode === "rotate") {
            const finalRotation = e && sprite ? computeRotationDrag(e.global) : null;
            const finalAngle = finalRotation?.newParamAngle ?? current.lastRotationParam;

            if (typeof finalAngle === "number") {
              const angleCommit = applyCommit(
                latestClip,
                nextTransforms,
                "rotation",
                "angle",
                finalAngle,
                current.transformIds.rotation ?? undefined,
              );
              if (angleCommit) {
                current.transformIds.rotation = angleCommit.transformId;
              }
            }
          }
        }
      }

      resetInteractionState();
      unbindStageListeners();
      if (sprite) {
        // eslint-disable-next-line react-hooks/immutability
        sprite.cursor = "grab";
      }
    }

    const onSpritePointerDown = (e: FederatedPointerEvent) => {
      if (e.button !== 0 || !sprite || !viewport) return;

      const activeClip = activeClipRef.current;
      if (!activeClip) return;

      e.stopPropagation();
      setIsPlaying(false);

      const modifierEvent = e.originalEvent as {
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
      };
      const isMulti =
        Boolean(modifierEvent.shiftKey) ||
        Boolean(modifierEvent.ctrlKey) ||
        Boolean(modifierEvent.metaKey);
      selectClip(activeClip.id, isMulti);

      const transform = activeClip.transformations?.find(
        (item) => item.type === "position",
      ) as PositionTransform | undefined;

      const clampedGlobal = Math.max(
        activeClip.start,
        Math.min(playbackClock.time, activeClip.start + activeClip.timelineDuration),
      );
      const localVisualTime = clampedGlobal - activeClip.start;
      const transformInputTime = transform
        ? getTransformInputTimeAtVisualOffset(activeClip, transform.id, localVisualTime)
        : localVisualTime;

      const startX = transform
        ? resolveScalar(transform.parameters.x, transformInputTime, 0)
        : 0;
      const startY = transform
        ? resolveScalar(transform.parameters.y, transformInputTime, 0)
        : 0;

      const localPos = toViewportLocal(viewport, e.global);
      interactionRef.current = {
        ...createInitialInteractionState(),
        active: true,
        clipId: activeClip.id,
        mode: "translate",
        startLocal: { x: localPos.x, y: localPos.y },
        startSprite: { x: sprite.position.x, y: sprite.position.y },
        startParams: { x: startX, y: startY, angle: 0 },
        transformIds: {
          position: transform?.id ?? null,
          scale: null,
          rotation: null,
        },
        lastPositionParams: { x: startX, y: startY },
      };

      bindStageListeners();
      // eslint-disable-next-line react-hooks/immutability
      sprite.cursor = "grabbing";
    };

    const onHandlePointerDown = (e: FederatedPointerEvent, key: string) => {
      if (!sprite || !viewport) return;

      const activeClip = activeClipRef.current;
      if (!activeClip) return;

      e.stopPropagation();
      setIsPlaying(false);

      const mode: InteractionMode = e.altKey ? "rotate" : "scale";
      let nextTransforms = [...(activeClip.transformations || [])];
      let scaleTransform = nextTransforms.find(
        (transform) => transform.type === "scale",
      ) as ScaleTransform | undefined;
      let rotationTransform = nextTransforms.find(
        (transform) => transform.type === "rotation",
      ) as RotationTransform | undefined;

      let didMaterializeTransform = false;
      if (mode === "scale" && !scaleTransform) {
        const createdScale = createAddTransform("scale");
        if (createdScale) {
          nextTransforms = insertTransformRespectingDefaultOrder(
            nextTransforms,
            createdScale,
          );
          scaleTransform = createdScale as ScaleTransform;
          didMaterializeTransform = true;
        }
      }
      if (mode === "rotate" && !rotationTransform) {
        const createdRotation = createAddTransform("rotation");
        if (createdRotation) {
          nextTransforms = insertTransformRespectingDefaultOrder(
            nextTransforms,
            createdRotation,
          );
          rotationTransform = createdRotation as RotationTransform;
          didMaterializeTransform = true;
        }
      }

      if (didMaterializeTransform) {
        setClipTransforms(activeClip.id, nextTransforms);
        activeClipRef.current = {
          ...activeClip,
          transformations: nextTransforms,
        };
      }

      const clampedGlobal = Math.max(
        activeClip.start,
        Math.min(playbackClock.time, activeClip.start + activeClip.timelineDuration),
      );
      const localVisualTime = clampedGlobal - activeClip.start;
      const scaleInputTime = scaleTransform
        ? getTransformInputTimeAtVisualOffset(activeClip, scaleTransform.id, localVisualTime)
        : localVisualTime;
      const rotationInputTime = rotationTransform
        ? getTransformInputTimeAtVisualOffset(activeClip, rotationTransform.id, localVisualTime)
        : localVisualTime;

      const paramX = scaleTransform
        ? resolveScalar(scaleTransform.parameters.x, scaleInputTime, 1)
        : 1;
      const paramY = scaleTransform
        ? resolveScalar(scaleTransform.parameters.y, scaleInputTime, 1)
        : 1;
      const paramAngle = rotationTransform
        ? resolveScalar(rotationTransform.parameters.angle, rotationInputTime, 0)
        : 0;

      const localPos = toViewportLocal(viewport, e.global);
      const visualScaleX = sprite.scale.x;
      const visualScaleY = sprite.scale.y;
      const baseX = Math.abs(paramX) > 0.001 ? visualScaleX / paramX : 1;
      const baseY = Math.abs(paramY) > 0.001 ? visualScaleY / paramY : 1;

      interactionRef.current = {
        ...createInitialInteractionState(),
        active: true,
        clipId: activeClip.id,
        mode,
        handle: key,
        startLocal: { x: localPos.x, y: localPos.y },
        startSprite: { x: sprite.position.x, y: sprite.position.y },
        startVisualScale: { x: visualScaleX, y: visualScaleY },
        startVisualRotation: sprite.rotation,
        startParams: { x: paramX, y: paramY, angle: paramAngle },
        baseScale: { x: baseX, y: baseY },
        transformIds: {
          position: null,
          scale: scaleTransform?.id ?? null,
          rotation: rotationTransform?.id ?? null,
        },
      };

      if (mode === "rotate") {
        const spriteGlobal = sprite.getGlobalPosition();
        interactionRef.current.initialAngle = getAngleFromPoint(
          e.global,
          spriteGlobal,
        );
      }

      bindStageListeners();
      // eslint-disable-next-line react-hooks/immutability
      sprite.cursor = "grabbing";
    };

    return { onSpritePointerDown, onHandlePointerDown, unbindStageListeners };
  }, [
    sprite,
    viewport,
    app,
    activeClipRef,
    setIsPlaying,
    addClipTransform,
    updateClipTransform,
    setClipTransforms,
    selectClip,
  ]);

  useEffect(() => {
    return () => {
      handlers.unbindStageListeners();
    };
  }, [handlers]);

  return {
    onSpritePointerDown: handlers.onSpritePointerDown,
    onHandlePointerDown: handlers.onHandlePointerDown,
  };
}
