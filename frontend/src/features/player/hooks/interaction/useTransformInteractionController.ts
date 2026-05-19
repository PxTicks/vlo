import { useEffect, useMemo, useRef } from "react";
import { Graphics } from "pixi.js";
import type { Application, Container, FederatedPointerEvent, Sprite } from "pixi.js";
import { getTimelineClipById, useTimelineStore } from "../../../timeline";
import { usePlayerStore } from "../../usePlayerStore";
import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";
import type { ClipTransform, TimelineClip } from "../../../../types/TimelineTypes";
import type {
  PositionTransform,
  PositionPathParameter,
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
import { useTransformationViewStore } from "../../../transformations/store/useTransformationViewStore";
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
  lockCornerScaleAspectRatio,
} from "./layoutInteractionMath";
import {
  type Point2D,
} from "../../../transformations/utils/catmullRomUtils";
import {
  samplePositionPath,
  resolvePositionPathProgress,
} from "../../../transformations/utils/positionPath";
import {
  appendRecordPathSample,
  applyEditPathSample,
  createInitialPositionPathDragState,
  drawPositionPathOverlay,
  finalizePositionPathEdit,
  finalizePositionPathRecording,
  type PositionPathDragState,
} from "../../../transformations/utils/positionPathDrag";
import {
  getPositionPath,
  getPositionTransform,
} from "../../../transformations/utils/positionPathState";

const POINT_EPSILON_TICKS = 1;
const DRAG_MOVE_EPSILON = 0.01;
const PATH_PROGRESS_EPSILON = 0.02;
const PATH_RECORDING_SPATIAL_EPSILON = 6;
const PATH_RECORDING_SIMPLIFY_EPSILON = 4;

type InteractionMode =
  | "translate"
  | "scale"
  | "rotate"
  | "recordPath"
  | "editPath";

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
  path: PositionPathDragState;
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
    path: createInitialPositionPathDragState(),
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
  onLiveSpriteTransform?: () => void,
): TransformInteractionHandlers {
  const setIsPlaying = usePlayerStore((state) => state.setIsPlaying);
  const addClipTransform = useTimelineStore((state) => state.addClipTransform);
  const updateClipTransform = useTimelineStore((state) => state.updateClipTransform);
  const setClipTransforms = useTimelineStore((state) => state.setClipTransforms);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const selectedClipId = useTimelineStore(
    (state) => state.selectedClipIds[0] ?? null,
  );
  const selectCanvasClip = useCanvasSelectionStore((state) => state.selectClip);
  const armedPathRecording = useTransformationViewStore(
    (state) => state.armedPathRecording,
  );
  const activePathEditor = useTransformationViewStore(
    (state) => state.activePathEditor,
  );
  const pathPanelView = useTransformationViewStore((state) => state.pathPanelView);
  const setArmedPathRecording = useTransformationViewStore(
    (state) => state.setArmedPathRecording,
  );
  const setActivePathEditor = useTransformationViewStore(
    (state) => state.setActivePathEditor,
  );
  const setPathPanelView = useTransformationViewStore(
    (state) => state.setPathPanelView,
  );

  const interactionRef = useRef<InteractionState>(createInitialInteractionState());
  const pathOverlayRef = useRef<Graphics | null>(null);
  const resolveViewportCenter = (): Point2D | null => {
    if (!app || !viewport) return null;
    return toViewportLocal(viewport, {
      x: app.screen.width / 2,
      y: app.screen.height / 2,
    });
  };

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
      current.path = createInitialPositionPathDragState();
      current.didMove = false;
    };

    const resolveLocalVisualTime = (clip: TimelineClip): number => {
      const clampedGlobal = Math.max(
        clip.start,
        Math.min(playbackClock.time, clip.start + clip.timelineDuration),
      );
      return clampedGlobal - clip.start;
    };

    const resolvePositionAtVisualTime = (
      clip: TimelineClip,
      transform: PositionTransform | undefined,
      localVisualTime: number,
    ) => {
      const path = transform?.parameters.path ?? null;
      if (path) {
        const sampled = samplePositionPath(
          path,
          localVisualTime,
          clip.timelineDuration,
        );
        return {
          x: sampled.x,
          y: sampled.y,
          path,
        };
      }

      const transformInputTime = transform
        ? getTransformInputTimeAtVisualOffset(clip, transform.id, localVisualTime)
        : localVisualTime;

      return {
        x: transform
          ? resolveScalar(transform.parameters.x, transformInputTime, 0)
          : 0,
        y: transform
          ? resolveScalar(transform.parameters.y, transformInputTime, 0)
          : 0,
        path: null,
      };
    };

    const commitPositionPath = (
      clip: TimelineClip,
      path: PositionPathParameter,
      existingTransformId?: string | null,
    ): string | null => {
      const positionTransform =
        (existingTransformId
          ? clip.transformations.find(
              (transform) => transform.id === existingTransformId,
            )
          : getPositionTransform(clip)) as PositionTransform | undefined;

      if (positionTransform) {
        updateClipTransform(clip.id, positionTransform.id, {
          parameters: {
            ...positionTransform.parameters,
            path,
          },
        });
        return positionTransform.id;
      }

      const created = createAddTransform("position") as PositionTransform | null;
      if (!created) {
        return null;
      }

      created.parameters = {
        ...created.parameters,
        path,
      };

      const nextTransforms = insertTransformRespectingDefaultOrder(
        clip.transformations || [],
        created,
      );
      setClipTransforms(clip.id, nextTransforms);
      return created.id;
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
      const newVisualScaleY = scaleDrag.scale.y;

      const lockedParamScale = lockCornerScaleAspectRatio(
        current.handle,
        { x: current.startParams.x, y: current.startParams.y },
        {
          x: newVisualScaleX / current.baseScale.x,
          y: newVisualScaleY / current.baseScale.y,
        },
      );

      return {
        localDx: scaleDrag.localDelta.x,
        localDy: scaleDrag.localDelta.y,
        newParamX: lockedParamScale.x,
        newParamY: lockedParamScale.y,
        newVisualScaleX,
        newVisualScaleY: lockedParamScale.y * current.baseScale.y,
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

      if (current.mode === "recordPath" || current.mode === "editPath") {
        const localPos = toViewportLocal(viewport, e.global);
        const deltaX = localPos.x - current.startLocal.x;
        const deltaY = localPos.y - current.startLocal.y;
        const startPosition: Point2D = {
          x: current.startParams.x,
          y: current.startParams.y,
        };
        const currentPosition: Point2D = {
          x: startPosition.x + deltaX,
          y: startPosition.y + deltaY,
        };
        current.lastPositionParams = currentPosition;

        const moved = hasDragMovement(DRAG_MOVE_EPSILON, deltaX, deltaY);
        if (moved) {
          current.didMove = true;
        }

        sprite.position.set(
          current.startSprite.x + deltaX,
          current.startSprite.y + deltaY,
        );
        onLiveSpriteTransform?.();

        if (current.mode === "recordPath") {
          appendRecordPathSample(current.path, {
            startPosition,
            currentPosition,
            eventTimeStamp: e.timeStamp,
            hasMoved: current.didMove,
          });
        } else {
          applyEditPathSample(current.path, {
            currentPosition,
            progressEpsilon: PATH_PROGRESS_EPSILON,
          });
        }

        return;
      }

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
        onLiveSpriteTransform?.();

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
        onLiveSpriteTransform?.();
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
        onLiveSpriteTransform?.();
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

          if (current.mode === "recordPath") {
            const startPosition: Point2D = {
              x: current.startParams.x,
              y: current.startParams.y,
            };
            const finalPosition: Point2D | null =
              e && viewport
                ? (() => {
                    const localPos = toViewportLocal(viewport, e.global);
                    return {
                      x: startPosition.x + (localPos.x - current.startLocal.x),
                      y: startPosition.y + (localPos.y - current.startLocal.y),
                    };
                  })()
                : current.lastPositionParams;

            if (finalPosition) {
              const path = finalizePositionPathRecording(current.path, {
                startPosition,
                finalPosition,
                spatialEpsilon: PATH_RECORDING_SPATIAL_EPSILON,
                simplifyEpsilon: PATH_RECORDING_SIMPLIFY_EPSILON,
              });
              if (path) {
                const transformId = commitPositionPath(
                  latestClip,
                  path,
                  current.transformIds.position,
                );
                if (transformId) {
                  setArmedPathRecording(null);
                  setActivePathEditor({
                    clipId: latestClip.id,
                    transformId,
                  });
                  setPathPanelView("path");
                }
              }
            }
          } else if (current.mode === "editPath") {
            const startPosition: Point2D = {
              x: current.startParams.x,
              y: current.startParams.y,
            };
            const finalPosition: Point2D | null =
              e && viewport
                ? (() => {
                    const localPos = toViewportLocal(viewport, e.global);
                    return {
                      x: startPosition.x + (localPos.x - current.startLocal.x),
                      y: startPosition.y + (localPos.y - current.startLocal.y),
                    };
                  })()
                : current.lastPositionParams;

            if (finalPosition && current.path.activePath) {
              const nextControlPoints = finalizePositionPathEdit(current.path, {
                finalPosition,
                progressEpsilon: PATH_PROGRESS_EPSILON,
              });
              if (nextControlPoints) {
                const transformId = commitPositionPath(
                  latestClip,
                  {
                    ...current.path.activePath,
                    controlPoints: nextControlPoints,
                  },
                  current.transformIds.position,
                );
                if (transformId) {
                  setActivePathEditor({
                    clipId: latestClip.id,
                    transformId,
                  });
                  setPathPanelView("path");
                }
              }
            }
          } else if (current.mode === "translate") {
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
              // Rotation params are stored in radians (model space), but the
              // commit pipeline applies the rotation control's `toModel`
              // (degrees → radians) to incoming values. Hand it the view-space
              // (degrees) value so the round-trip lands in radians.
              const finalAngleDegrees = (finalAngle * 180) / Math.PI;
              const angleCommit = applyCommit(
                latestClip,
                nextTransforms,
                "rotation",
                "angle",
                finalAngleDegrees,
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
      selectCanvasClip(activeClip.id);

      const transform = getPositionTransform(activeClip) ?? undefined;
      const localVisualTime = resolveLocalVisualTime(activeClip);
      const {
        x: startX,
        y: startY,
        path: activePath,
      } = resolvePositionAtVisualTime(activeClip, transform, localVisualTime);
      const isArmedRecording = armedPathRecording?.clipId === activeClip.id;
      const isPathEditing =
        pathPanelView === "path" &&
        activePathEditor?.clipId === activeClip.id &&
        activePathEditor.transformId === transform?.id &&
        !!activePath;

      if (activePath && !isArmedRecording && !isPathEditing) {
        return;
      }

      const localPos = toViewportLocal(viewport, e.global);
      const initialPathState = createInitialPositionPathDragState();
      initialPathState.activePath = activePath;
      initialPathState.draftPathControlPoints =
        activePath?.controlPoints ?? null;
      initialPathState.lastPositionParams = { x: startX, y: startY };
      initialPathState.pathProgress =
        activePath && isPathEditing
          ? resolvePositionPathProgress(
              activePath,
              localVisualTime,
              activeClip.timelineDuration,
            )
          : null;

      interactionRef.current = {
        ...createInitialInteractionState(),
        active: true,
        clipId: activeClip.id,
        mode: isArmedRecording
          ? "recordPath"
          : isPathEditing
            ? "editPath"
            : "translate",
        startLocal: { x: localPos.x, y: localPos.y },
        startSprite: { x: sprite.position.x, y: sprite.position.y },
        startParams: { x: startX, y: startY, angle: 0 },
        transformIds: {
          position: transform?.id ?? null,
          scale: null,
          rotation: null,
        },
        lastPositionParams: { x: startX, y: startY },
        path: initialPathState,
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
      selectCanvasClip(activeClip.id);

      const isRotateHandle = key.startsWith("rot-");
      const mode: InteractionMode =
        isRotateHandle || e.altKey ? "rotate" : "scale";
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
    onLiveSpriteTransform,
    activeClipRef,
    armedPathRecording,
    activePathEditor,
    pathPanelView,
    setIsPlaying,
    addClipTransform,
    updateClipTransform,
    setClipTransforms,
    selectClip,
    selectCanvasClip,
    setArmedPathRecording,
    setActivePathEditor,
    setPathPanelView,
  ]);

  useEffect(() => {
    if (!viewport) {
      if (pathOverlayRef.current && !pathOverlayRef.current.destroyed) {
        pathOverlayRef.current.destroy();
      }
      pathOverlayRef.current = null;
      return;
    }

    const overlay = new Graphics();
    overlay.zIndex = 9998;
    viewport.addChild(overlay);
    pathOverlayRef.current = overlay;

    return () => {
      if (pathOverlayRef.current === overlay) {
        pathOverlayRef.current = null;
      }
      overlay.destroy();
    };
  }, [viewport]);

  useEffect(() => {
    if (!app) {
      return;
    }

    const drawOverlay = () => {
      const overlay = pathOverlayRef.current;
      if (!overlay) {
        return;
      }

      overlay.clear();

      const activeClip = activeClipRef.current;
      if (
        !overlay ||
        !sprite ||
        !activeClip ||
        selectedClipId !== activeClip.id ||
        !sprite.visible
      ) {
        overlay.visible = false;
        return;
      }

      const currentInteraction = interactionRef.current;
      const interactionMatchesClip =
        currentInteraction.active &&
        currentInteraction.clipId === activeClip.id;
      let controlPoints: Point2D[] | null = null;
      let currentPoint: Point2D | null = null;
      let isProvisional = false;

      if (
        interactionMatchesClip &&
        currentInteraction.mode === "recordPath" &&
        currentInteraction.path.rawPathSamples.length > 0
      ) {
        controlPoints = currentInteraction.path.rawPathSamples.map(
          (sample) => sample.point,
        );
        currentPoint =
          currentInteraction.path.lastPositionParams ??
          currentInteraction.path.rawPathSamples[
            currentInteraction.path.rawPathSamples.length - 1
          ]?.point ??
          null;
        isProvisional = true;
      } else {
        const persistedPath = getPositionPath(activeClip);
        if (!persistedPath) {
          overlay.visible = false;
          return;
        }

        const pathToRender =
          interactionMatchesClip &&
          currentInteraction.mode === "editPath" &&
          currentInteraction.path.draftPathControlPoints
            ? {
                ...persistedPath,
                controlPoints: currentInteraction.path.draftPathControlPoints,
              }
            : persistedPath;

        const clampedGlobal = Math.max(
          activeClip.start,
          Math.min(
            playbackClock.time,
            activeClip.start + activeClip.timelineDuration,
          ),
        );
        const localVisualTime = clampedGlobal - activeClip.start;
        controlPoints = pathToRender.controlPoints;
        currentPoint =
          interactionMatchesClip &&
          currentInteraction.mode === "editPath" &&
          currentInteraction.path.lastPositionParams
            ? currentInteraction.path.lastPositionParams
            : samplePositionPath(
                pathToRender,
                localVisualTime,
                activeClip.timelineDuration,
              );
        isProvisional =
          interactionMatchesClip && currentInteraction.mode === "editPath";
      }

      if (!controlPoints || controlPoints.length === 0 || !currentPoint) {
        overlay.visible = false;
        return;
      }

      const viewportCenter = resolveViewportCenter();
      if (!viewportCenter) {
        overlay.visible = false;
        return;
      }

      overlay.visible = true;
      drawPositionPathOverlay(overlay, {
        controlPoints,
        currentPoint,
        // Anchor the path to the stable viewport center rather than the
        // live sprite position, which can momentarily lag while scrubbing.
        baseOrigin: viewportCenter,
        isProvisional,
      });
    };

    app.ticker.add(drawOverlay);
    const unsubscribe = playbackClock.subscribe(() => drawOverlay());
    drawOverlay();

    return () => {
      app.ticker.remove(drawOverlay);
      unsubscribe();
      if (pathOverlayRef.current) {
        pathOverlayRef.current.clear();
        pathOverlayRef.current.visible = false;
      }
    };
  }, [activeClipRef, app, selectedClipId, sprite]);

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
