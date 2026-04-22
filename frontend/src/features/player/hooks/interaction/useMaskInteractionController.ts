import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Sprite,
} from "pixi.js";
import {
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Sprite as PixiSprite,
  Texture,
} from "pixi.js";
import type {
  ClipMaskPoint,
  ClipTransform,
  TimelineClip,
  ClipMask,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";
import {
  TICKS_PER_SECOND,
  getTimelineClipById,
  useTimelineStore,
  selectMaskClipsForParent,
  parseMaskClipId,
} from "../../../timeline";
import { usePlayerStore } from "../../usePlayerStore";
import { useShallow } from "zustand/react/shallow";
import {
  calculateClipTime,
  commitLayoutControlToTransforms,
  liveParamStore,
} from "../../../transformations";
import { hasDragMovement } from "./transformInteraction";
import { playbackClock } from "../../services/PlaybackClock";
import {
  bindStagePointerListeners,
  unbindStagePointerListeners,
} from "./pointerStage";
import { computeHandleScale, getAngleFromPoint } from "./layoutInteractionMath";
import {
  createMaskLayoutTransforms,
  createMask,
  drawMaskBaseShape,
  getMaskLayoutState,
  isPointInsideMask,
  type MaskLayoutState,
  type MaskShapeSource,
} from "../../../masks/model/maskFactory";
import { resolveMaskLayoutStateAtTime } from "../../../masks/model/maskTimelineClip";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import { syncContainerTransformToTarget } from "../../../renderer";
import { useProjectStore } from "../../../project/useProjectStore";

const MIN_DRAW_SIZE = 3;
const MIN_SCALE = 0.05;
const DRAG_MOVE_EPSILON = 0.01;
const KEYFRAME_POINT_EPSILON_TICKS = 1;
const MIN_POINT_TIME_EPSILON_TICKS = 1;
const SAM2_POINT_RADIUS = 8;
const SAM2_POINT_HIT_RADIUS = 12;
const SAM2_POINT_BORDER_WIDTH = 2;
const SAM2_BORDER_COLOR = 0x60a5fa;

const INHERITED_TRANSFORM_TYPES = new Set(["speed"]);

type MaskInteractionMode = "idle" | "draw" | "translate" | "scale" | "rotate";

interface MaskLayoutTransformIds {
  position: string | null;
  scale: string | null;
  rotation: string | null;
}

interface MaskInteractionState {
  active: boolean;
  mode: MaskInteractionMode;
  clipId: string | null;
  maskId: string | null;
  handle: string | null;
  startLocal: { x: number; y: number };
  startLayout: MaskLayoutState | null;
  startBaseSize: { width: number; height: number } | null;
  initialAngle: number;
  transformIds: MaskLayoutTransformIds;
  didMove: boolean;
}

function createInitialMaskInteractionState(): MaskInteractionState {
  return {
    active: false,
    mode: "idle",
    clipId: null,
    maskId: null,
    handle: null,
    startLocal: { x: 0, y: 0 },
    startLayout: null,
    startBaseSize: null,
    initialAngle: 0,
    transformIds: {
      position: null,
      scale: null,
      rotation: null,
    },
    didMove: false,
  };
}

interface LiveMaskLayoutPreview {
  clipId: string;
  maskId: string;
  layout: MaskLayoutState;
}

/** Get mask-local transforms (exclude inherited speed transforms). */
function getMaskLocalTransforms(maskClip: MaskTimelineClip): ClipTransform[] {
  return (maskClip.transformations || []).filter(
    (t) => !INHERITED_TRANSFORM_TYPES.has(t.type),
  );
}

function resolveMaskLayoutTransformIds(
  maskClip: MaskTimelineClip,
): MaskLayoutTransformIds {
  const transforms = getMaskLocalTransforms(maskClip);
  return {
    position:
      transforms.find((transform) => transform.type === "position")?.id ?? null,
    scale:
      transforms.find((transform) => transform.type === "scale")?.id ?? null,
    rotation:
      transforms.find((transform) => transform.type === "rotation")?.id ?? null,
  };
}

function notifyLiveMaskLayout(
  transformIds: MaskLayoutTransformIds,
  layout: MaskLayoutState,
) {
  if (transformIds.position) {
    liveParamStore.notify(transformIds.position, "x", layout.x);
    liveParamStore.notify(transformIds.position, "y", layout.y);
  }
  if (transformIds.scale) {
    liveParamStore.notify(transformIds.scale, "x", layout.scaleX);
    liveParamStore.notify(transformIds.scale, "y", layout.scaleY);
  }
  if (transformIds.rotation) {
    liveParamStore.notify(transformIds.rotation, "angle", layout.rotation);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeSam2PointCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return clamp01(value);
}

function normalizeSam2Points(
  points: ClipMaskPoint[] | undefined,
): ClipMaskPoint[] {
  if (!points || points.length === 0) return [];
  return points.map((point) => ({
    x: normalizeSam2PointCoordinate(point.x),
    y: normalizeSam2PointCoordinate(point.y),
    label: point.label === 0 ? 0 : 1,
    timeTicks:
      typeof point.timeTicks === "number" && Number.isFinite(point.timeTicks)
        ? point.timeTicks
        : 0,
  }));
}

interface SelectedMaskContext {
  selectedClipId: string | null;
  selectedClip: TimelineClip | null;
  selectedMaskClip: MaskTimelineClip | null;
  maskLocalId: string | null;
}

function resolveSelectedMaskContext(): SelectedMaskContext {
  const timelineState = useTimelineStore.getState();
  const selectedClipId = timelineState.selectedClipIds[0] ?? null;
  const selectedClip = getTimelineClipById(selectedClipId) ?? null;

  if (!selectedClipId || !selectedClip) {
    return {
      selectedClipId,
      selectedClip,
      selectedMaskClip: null,
      maskLocalId: null,
    };
  }

  const selectedMaskId =
    useMaskViewStore.getState().selectedMaskByClipId[selectedClipId] ?? null;
  if (!selectedMaskId) {
    return {
      selectedClipId,
      selectedClip,
      selectedMaskClip: null,
      maskLocalId: null,
    };
  }

  const maskClips = selectMaskClipsForParent(timelineState, selectedClipId);
  const maskClip =
    maskClips.find((c) => {
      const parsed = parseMaskClipId(c.id);
      return parsed?.maskId === selectedMaskId;
    }) ?? null;

  return {
    selectedClipId,
    selectedClip,
    selectedMaskClip: maskClip,
    maskLocalId: selectedMaskId,
  };
}

interface MaskInteractionHandlers {
  onSpritePointerDown: (e: FederatedPointerEvent) => boolean;
  onMaskPointerDown: (e: FederatedPointerEvent) => boolean;
  onHandlePointerDown: (e: FederatedPointerEvent, key: string) => void;
  gizmoTarget: Container | null;
  isMaskGizmoVisible: boolean;
}

export function useMaskInteractionController(
  sprite: Sprite | null,
  activeClipRef: React.MutableRefObject<TimelineClip | null>,
  app: Application | null,
  viewport: Container | null,
): MaskInteractionHandlers {
  const setIsPlaying = usePlayerStore((state) => state.setIsPlaying);
  const projectFps = useProjectStore((state) => state.config.fps);
  const addClipMask = useTimelineStore((state) => state.addClipMask);
  const updateClipMask = useTimelineStore((state) => state.updateClipMask);
  const selectClip = useTimelineStore((state) => state.selectClip);

  const setSelectedMask = useMaskViewStore((state) => state.setSelectedMask);
  const clearPendingDraw = useMaskViewStore((state) => state.clearPendingDraw);
  const setInteractionContext = useMaskViewStore(
    (state) => state.setInteractionContext,
  );

  const selectedClipId = useTimelineStore(
    (state) => state.selectedClipIds[0] ?? null,
  );
  const selectedMaskId = useMaskViewStore((state) =>
    selectedClipId
      ? (state.selectedMaskByClipId[selectedClipId] ?? null)
      : null,
  );
  const isMaskTabActive = useMaskViewStore((state) => state.isMaskTabActive);
  const sam2PointMode = useMaskViewStore((state) => state.sam2PointMode);
  const pendingDrawRequest = useMaskViewStore(
    (state) => state.pendingDrawRequest,
  );

  const selectedMaskClip = useTimelineStore(
    useShallow((state) => {
      if (!selectedClipId || !selectedMaskId) return null;
      const maskClips = selectMaskClipsForParent(state, selectedClipId);
      return (
        maskClips.find(
          (c) => parseMaskClipId(c.id)?.maskId === selectedMaskId,
        ) ?? null
      );
    }),
  );

  const interactionRef = useRef<MaskInteractionState>(
    createInitialMaskInteractionState(),
  );
  const draftMaskShapeRef = useRef<MaskShapeSource | null>(null);
  const liveMaskLayoutPreviewRef = useRef<LiveMaskLayoutPreview | null>(null);

  const clipOverlayRef = useRef<Container | null>(null);
  const maskOverlayRef = useRef<Container | null>(null);
  const maskGraphicsRef = useRef<Graphics | null>(null);
  const sam2PointsGraphicsRef = useRef<Graphics | null>(null);
  const sam2PreviewSpriteRef = useRef<Sprite | null>(null);
  const sam2PreviewTextureUrlRef = useRef<string>("");
  const sam2PreviewBitmapRef = useRef<ImageBitmap | null>(null);
  const overlayShapeSignatureRef = useRef<string>("");

  const [gizmoTarget, setGizmoTarget] = useState<Container | null>(null);
  const [isMaskGizmoVisible, setIsMaskGizmoVisible] = useState(false);
  const pointTimeEpsilonTicks = useMemo(() => {
    const safeFps =
      typeof projectFps === "number" &&
      Number.isFinite(projectFps) &&
      projectFps > 0
        ? projectFps
        : 30;
    return Math.max(MIN_POINT_TIME_EPSILON_TICKS, TICKS_PER_SECOND / safeFps);
  }, [projectFps]);

  const toClipLocal = useCallback((global: { x: number; y: number }) => {
    if (!clipOverlayRef.current) return { x: 0, y: 0 };
    return clipOverlayRef.current.toLocal(global);
  }, []);

  const resolveActiveClipContentSize = useCallback(() => {
    const texture = sprite?.texture;
    if (
      texture &&
      // Pixi uses EMPTY texture placeholders before a real frame is ready.
      // We only need a non-zero drawable size here.
      texture.width > 0 &&
      texture.height > 0
    ) {
      return {
        width: texture.width,
        height: texture.height,
      };
    }

    if (sprite) {
      const bounds = sprite.getLocalBounds();
      if (bounds.width > 0 && bounds.height > 0) {
        return {
          width: bounds.width,
          height: bounds.height,
        };
      }
    }

    return {
      width: 1,
      height: 1,
    };
  }, [sprite]);

  const resolveMaskLayoutAtPlayhead = useCallback(
    (maskClip: MaskTimelineClip): MaskLayoutState => {
      const rawTimeTicks = playbackClock.time - maskClip.start;
      return resolveMaskLayoutStateAtTime(maskClip, rawTimeTicks);
    },
    [],
  );

  const resolveMaskInputTimeAtPlayhead = useCallback(
    (maskClip: MaskTimelineClip) => {
      const clampedGlobal = Math.max(
        maskClip.start,
        Math.min(
          playbackClock.time,
          maskClip.start + maskClip.timelineDuration,
        ),
      );
      const localVisualTicks = clampedGlobal - maskClip.start;
      return calculateClipTime(maskClip, localVisualTicks, true);
    },
    [],
  );

  const resolveMaskForHitTest = useCallback(
    (maskClip: MaskTimelineClip): MaskShapeSource => {
      const resolvedLayout = resolveMaskLayoutAtPlayhead(maskClip);
      return {
        maskType: maskClip.maskType,
        maskParameters: maskClip.maskParameters,
        transformations: createMaskLayoutTransforms(
          maskClip.id,
          resolvedLayout,
        ),
        id: maskClip.id,
      };
    },
    [resolveMaskLayoutAtPlayhead],
  );

  const syncOverlayToSprite = useCallback(() => {
    const clipOverlay = clipOverlayRef.current;
    if (!clipOverlay || !sprite) return false;
    return syncContainerTransformToTarget(clipOverlay, sprite);
  }, [sprite]);

  const applyLayoutToOverlay = useCallback((layout: MaskLayoutState) => {
    const clipOverlay = clipOverlayRef.current;
    const maskOverlay = maskOverlayRef.current;
    if (!clipOverlay || !maskOverlay) return;
    clipOverlay.visible = true;
    maskOverlay.position.set(layout.x, layout.y);
    maskOverlay.scale.set(layout.scaleX, layout.scaleY);
    maskOverlay.rotation = layout.rotation;
  }, []);

  const setLiveMaskLayoutPreview = useCallback(
    (clipId: string, maskId: string, layout: MaskLayoutState) => {
      liveMaskLayoutPreviewRef.current = { clipId, maskId, layout };
      applyLayoutToOverlay(layout);
    },
    [applyLayoutToOverlay],
  );

  const clearLiveMaskLayoutPreview = useCallback(() => {
    liveMaskLayoutPreviewRef.current = null;
  }, []);

  const toSam2NormalizedPoint = useCallback(
    (
      local: { x: number; y: number },
      contentSize: { width: number; height: number },
      label: 0 | 1,
      timeTicks: number,
    ): ClipMaskPoint => {
      return {
        x: clamp01(local.x / contentSize.width + 0.5),
        y: clamp01(local.y / contentSize.height + 0.5),
        label,
        timeTicks,
      };
    },
    [],
  );

  const toSam2LocalPoint = useCallback(
    (
      point: ClipMaskPoint,
      contentSize: { width: number; height: number },
    ): { x: number; y: number } => ({
      x: (point.x - 0.5) * contentSize.width,
      y: (point.y - 0.5) * contentSize.height,
    }),
    [],
  );

  const renderMaskToOverlay = useCallback(
    (mask: MaskShapeSource | null, layoutOverride?: MaskLayoutState | null) => {
      const clipOverlay = clipOverlayRef.current;
      const graphics = maskGraphicsRef.current;

      if (!clipOverlay || !graphics) return;

      if (!mask) {
        graphics.clear();
        clipOverlay.visible = false;
        overlayShapeSignatureRef.current = "";
        return;
      }

      const layout = layoutOverride ?? {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
      };
      applyLayoutToOverlay(layout);

      const params = mask.maskParameters ??
        mask.parameters ?? { baseWidth: 1, baseHeight: 1 };
      const shapeType = mask.maskType ?? mask.type ?? "rectangle";
      const shapeSignature = `${mask.id ?? ""}:${shapeType}:${params.baseWidth}:${params.baseHeight}`;
      if (overlayShapeSignatureRef.current !== shapeSignature) {
        graphics.clear();
        drawMaskBaseShape(graphics, mask);
        overlayShapeSignatureRef.current = shapeSignature;
      }
      const isDraft = mask.id === "draft_mask";
      const maskMode = (mask as MaskTimelineClip).maskMode;
      graphics.visible = true;
      graphics.alpha = maskMode === "preview" || isDraft ? 0.35 : 0;
    },
    [applyLayoutToOverlay],
  );

  const renderSam2PointsToOverlay = useCallback(
    (maskClip: MaskTimelineClip | null) => {
      const clipOverlay = clipOverlayRef.current;
      const pointsGraphics = sam2PointsGraphicsRef.current;
      if (!clipOverlay || !pointsGraphics) return;

      if (!maskClip) {
        pointsGraphics.visible = false;
        pointsGraphics.clear();
        return;
      }

      const contentSize = resolveActiveClipContentSize();
      const currentInputTime = resolveMaskInputTimeAtPlayhead(maskClip);
      const points = normalizeSam2Points(maskClip.maskPoints).filter(
        (point) =>
          Math.abs(point.timeTicks - currentInputTime) <= pointTimeEpsilonTicks,
      );
      const halfWidth = contentSize.width / 2;
      const halfHeight = contentSize.height / 2;

      pointsGraphics.visible = true;
      clipOverlay.visible = true;
      pointsGraphics.clear();
      pointsGraphics.alpha = 1;
      pointsGraphics
        .rect(-halfWidth, -halfHeight, contentSize.width, contentSize.height)
        .stroke({ width: 1, color: SAM2_BORDER_COLOR, alpha: 0.45 });

      points.forEach((point) => {
        const local = toSam2LocalPoint(point, contentSize);
        const fill = point.label === 1 ? 0x22c55e : 0xef4444;
        const border = point.label === 1 ? 0x16a34a : 0xdc2626;
        pointsGraphics
          .circle(local.x, local.y, SAM2_POINT_RADIUS)
          .fill(fill)
          .stroke({ width: SAM2_POINT_BORDER_WIDTH, color: border, alpha: 1 });
      });
    },
    [
      pointTimeEpsilonTicks,
      resolveActiveClipContentSize,
      resolveMaskInputTimeAtPlayhead,
      toSam2LocalPoint,
    ],
  );

  const updateSam2PreviewSprite = useCallback(
    (clipId: string, maskClip: MaskTimelineClip) => {
      const previewSprite = sam2PreviewSpriteRef.current;
      if (!previewSprite) return;

      if (maskClip.maskMode !== "preview") {
        previewSprite.visible = false;
        return;
      }

      const livePreview =
        useMaskViewStore.getState().sam2LivePreviewByClipId[clipId];
      if (!livePreview) {
        previewSprite.visible = false;
        return;
      }

      // Frame-aware: match by source frame index (not exact ticks) so the
      // preview remains visible across the whole frame interval.
      const currentInputTime = resolveMaskInputTimeAtPlayhead(maskClip);
      const sourceFps = Math.max(1, livePreview.sourceFps);
      const currentFrameIndex = Math.max(
        0,
        Math.floor(
          (Math.max(0, currentInputTime) / TICKS_PER_SECOND) * sourceFps,
        ),
      );
      // Predictor frame responses can lag the playhead by a frame or two during
      // scrubbing. Allow small drift so preview mode remains visibly continuous.
      const previewMatchesFrame =
        Math.abs(currentFrameIndex - livePreview.frameIndex) <= 2;
      if (!previewMatchesFrame) {
        previewSprite.visible = false;
        return;
      }

      const contentSize = resolveActiveClipContentSize();
      const bitmapKey = `${livePreview.maskId}:${livePreview.frameIndex}:${livePreview.width}x${livePreview.height}`;
      const shouldRefreshTexture =
        sam2PreviewTextureUrlRef.current !== bitmapKey ||
        sam2PreviewBitmapRef.current !== livePreview.bitmap;

      if (shouldRefreshTexture) {
        const oldTex = previewSprite.texture;
        if (oldTex && oldTex !== Texture.EMPTY && !oldTex.destroyed) {
          oldTex.destroy(true);
        }
        previewSprite.texture = Texture.from({
          resource: livePreview.bitmap,
          alphaMode: "premultiply-alpha-on-upload",
        });
        sam2PreviewTextureUrlRef.current = bitmapKey;
        sam2PreviewBitmapRef.current = livePreview.bitmap;
      }

      previewSprite.width = contentSize.width;
      previewSprite.height = contentSize.height;
      previewSprite.visible = true;
    },
    [resolveActiveClipContentSize, resolveMaskInputTimeAtPlayhead],
  );

  const clearSam2PreviewSprite = useCallback(() => {
    const previewSprite = sam2PreviewSpriteRef.current;
    if (previewSprite) {
      previewSprite.visible = false;
    }
  }, []);

  const updateSam2MaskPoints = useCallback(
    (
      clipId: string,
      maskLocalId: string,
      update: (points: ClipMaskPoint[]) => ClipMaskPoint[],
    ) => {
      const state = useTimelineStore.getState();
      const maskClips = selectMaskClipsForParent(state, clipId);
      const maskClip = maskClips.find((candidate) => {
        const parsed = parseMaskClipId(candidate.id);
        return parsed?.maskId === maskLocalId;
      });
      if (!maskClip || maskClip.maskType !== "sam2") return;

      const currentPoints = normalizeSam2Points(maskClip.maskPoints);
      const nextPoints = normalizeSam2Points(update(currentPoints));
      const didChange =
        nextPoints.length !== currentPoints.length ||
        nextPoints.some((point, index) => {
          const previous = currentPoints[index];
          return (
            !previous ||
            point.x !== previous.x ||
            point.y !== previous.y ||
            point.label !== previous.label
          );
        });
      if (!didChange) return;

      updateClipMask(clipId, maskLocalId, { maskPoints: nextPoints });
    },
    [updateClipMask],
  );

  const getTargetMaskForEditing = useCallback((): {
    clipId: string;
    maskClip: MaskTimelineClip;
    maskLocalId: string;
  } | null => {
    const context = resolveSelectedMaskContext();
    const activeClip = activeClipRef.current;

    if (
      !context.selectedClipId ||
      !context.selectedMaskClip ||
      !context.maskLocalId ||
      !activeClip
    ) {
      return null;
    }

    if (activeClip.id !== context.selectedClipId) return null;
    if (context.selectedMaskClip.maskMode === "off") return null;
    if (
      context.selectedMaskClip.maskType === "sam2" ||
      context.selectedMaskClip.maskType === "generation"
    ) {
      // Asset-backed masks are adjusted from the panel for now; they do not
      // expose the vector gizmo/point editor in the viewport interaction layer.
      return null;
    }

    return {
      clipId: context.selectedClipId,
      maskClip: context.selectedMaskClip,
      maskLocalId: context.maskLocalId,
    };
  }, [activeClipRef]);

  const getTargetSam2MaskForPointEditing = useCallback((): {
    clipId: string;
    maskClip: MaskTimelineClip;
    maskLocalId: string;
  } | null => {
    const context = resolveSelectedMaskContext();
    const activeClip = activeClipRef.current;

    if (
      !context.selectedClipId ||
      !context.selectedMaskClip ||
      !context.maskLocalId ||
      !activeClip
    ) {
      return null;
    }

    if (activeClip.id !== context.selectedClipId) return null;
    if (context.selectedMaskClip.maskType !== "sam2") return null;
    if (!isMaskTabActive) return null;

    return {
      clipId: context.selectedClipId,
      maskClip: context.selectedMaskClip,
      maskLocalId: context.maskLocalId,
    };
  }, [activeClipRef, isMaskTabActive]);

  const handlers = useMemo(() => {
    const resetInteractionState = () => {
      interactionRef.current = createInitialMaskInteractionState();
    };

    const unbindStageListeners = () => {
      unbindStagePointerListeners(app, onPointerMove, onPointerUp);
    };

    const bindStageListeners = () => {
      bindStagePointerListeners(app, onPointerMove, onPointerUp);
    };

    const commitMaskLayout = (
      clipId: string,
      maskLocalId: string,
      updates: Partial<MaskLayoutState>,
    ) => {
      const state = useTimelineStore.getState();
      const maskClips = selectMaskClipsForParent(state, clipId);
      const maskClip = maskClips.find((c) => {
        const parsed = parseMaskClipId(c.id);
        return parsed?.maskId === maskLocalId;
      });
      if (!maskClip) return;

      let nextTransforms = [...getMaskLocalTransforms(maskClip)];
      const commitLayoutControl = (
        groupId: "position" | "scale" | "rotation",
        controlName: "x" | "y" | "angle",
        value: number,
      ) => {
        const existingTransformId = nextTransforms.find(
          (transform) => transform.type === groupId,
        )?.id;
        const result = commitLayoutControlToTransforms({
          clip: maskClip,
          transforms: nextTransforms,
          groupId,
          controlName,
          value,
          transformId: existingTransformId,
          playheadTicks: playbackClock.time,
          pointEpsilonTicks: KEYFRAME_POINT_EPSILON_TICKS,
        });
        if (!result) return;
        nextTransforms = result.nextTransforms;
      };

      if (updates.x !== undefined) {
        commitLayoutControl("position", "x", updates.x);
      }
      if (updates.y !== undefined) {
        commitLayoutControl("position", "y", updates.y);
      }
      if (updates.scaleX !== undefined) {
        commitLayoutControl("scale", "x", updates.scaleX);
      }
      if (updates.scaleY !== undefined) {
        commitLayoutControl("scale", "y", updates.scaleY);
      }
      if (updates.rotation !== undefined) {
        commitLayoutControl("rotation", "angle", updates.rotation);
      }

      updateClipMask(clipId, maskLocalId, { transformations: nextTransforms });
    };

    function onPointerMove(e: FederatedPointerEvent) {
      const current = interactionRef.current;
      if (!current.active || !current.clipId) return;

      if (current.mode === "draw") {
        const pendingDraw = useMaskViewStore.getState().pendingDrawRequest;
        if (!pendingDraw) return;

        const currentLocal = toClipLocal(e.global);
        const deltaX = currentLocal.x - current.startLocal.x;
        const deltaY = currentLocal.y - current.startLocal.y;
        const width = Math.max(1, Math.abs(deltaX));
        const height = Math.max(1, Math.abs(deltaY));

        const nextDraft = createMask(pendingDraw.shape, {
          id: "draft_mask",
          parameters: {
            baseWidth: width,
            baseHeight: height,
          },
          transformations: createMaskLayoutTransforms("draft_mask", {
            x: current.startLocal.x + deltaX / 2,
            y: current.startLocal.y + deltaY / 2,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
          }),
        });

        draftMaskShapeRef.current = nextDraft;
        renderMaskToOverlay(nextDraft);
        return;
      }

      if (!current.maskId || !current.startLayout) return;

      const local = toClipLocal(e.global);
      const deltaX = local.x - current.startLocal.x;
      const deltaY = local.y - current.startLocal.y;
      const base = current.startLayout;

      if (current.mode === "translate") {
        const nextLayout: MaskLayoutState = {
          ...base,
          x: base.x + deltaX,
          y: base.y + deltaY,
        };
        current.didMove =
          current.didMove || hasDragMovement(DRAG_MOVE_EPSILON, deltaX, deltaY);
        setLiveMaskLayoutPreview(current.clipId, current.maskId, nextLayout);
        notifyLiveMaskLayout(current.transformIds, nextLayout);
        return;
      }

      if (current.mode === "scale") {
        const scaleDrag = computeHandleScale({
          handle: current.handle,
          startScale: { x: base.scaleX, y: base.scaleY },
          pointerDelta: { x: deltaX, y: deltaY },
          rotation: base.rotation,
          baseSize: {
            width: current.startBaseSize?.width ?? 1,
            height: current.startBaseSize?.height ?? 1,
          },
          minScale: MIN_SCALE,
        });

        const nextLayout: MaskLayoutState = {
          ...base,
          scaleX: scaleDrag.scale.x,
          scaleY: scaleDrag.scale.y,
        };
        current.didMove =
          current.didMove ||
          hasDragMovement(
            DRAG_MOVE_EPSILON,
            scaleDrag.localDelta.x,
            scaleDrag.localDelta.y,
          );
        setLiveMaskLayoutPreview(current.clipId, current.maskId, nextLayout);
        notifyLiveMaskLayout(current.transformIds, nextLayout);
        return;
      }

      if (current.mode === "rotate") {
        const angle = getAngleFromPoint(local, base);
        const nextLayout: MaskLayoutState = {
          ...base,
          rotation: base.rotation + (angle - current.initialAngle),
        };
        current.didMove =
          current.didMove ||
          hasDragMovement(
            DRAG_MOVE_EPSILON,
            nextLayout.rotation - base.rotation,
          );
        setLiveMaskLayoutPreview(current.clipId, current.maskId, nextLayout);
        notifyLiveMaskLayout(current.transformIds, nextLayout);
      }
    }

    function onPointerUp() {
      const current = interactionRef.current;
      if (!current.active) return;

      if (current.mode === "draw" && current.clipId) {
        const draftMask = draftMaskShapeRef.current;
        if (
          draftMask &&
          (draftMask.parameters?.baseWidth ?? 0) >= MIN_DRAW_SIZE &&
          (draftMask.parameters?.baseHeight ?? 0) >= MIN_DRAW_SIZE
        ) {
          const layout = getMaskLayoutState(draftMask as unknown as ClipMask);
          // Create the mask via the legacy ClipMask interface (addClipMask converts it)
          const finalMask = createMask(
            (draftMask.maskType ?? draftMask.type ?? "rectangle") as
              | "rectangle"
              | "circle"
              | "triangle",
            {
              parameters: {
                ...draftMask.parameters,
                ...layout,
              },
            },
          );
          addClipMask(current.clipId, finalMask);
          setSelectedMask(current.clipId, finalMask.id);
          setInteractionContext({
            clipId: current.clipId,
            mode: "edit",
            maskId: finalMask.id,
          });
        }

        clearPendingDraw();
        draftMaskShapeRef.current = null;
      } else if (current.clipId && current.maskId) {
        const liveLayoutPreview = liveMaskLayoutPreviewRef.current;
        if (
          current.didMove &&
          liveLayoutPreview &&
          liveLayoutPreview.clipId === current.clipId &&
          liveLayoutPreview.maskId === current.maskId
        ) {
          commitMaskLayout(
            current.clipId,
            current.maskId,
            liveLayoutPreview.layout,
          );
        }
        setInteractionContext({
          clipId: current.clipId,
          mode: "edit",
          maskId: current.maskId,
        });
      }

      clearLiveMaskLayoutPreview();
      resetInteractionState();
      unbindStageListeners();
    }

    const startMaskTranslateInteraction = (
      e: FederatedPointerEvent,
      target: {
        clipId: string;
        maskClip: MaskTimelineClip;
        maskLocalId: string;
      },
    ): boolean => {
      if (typeof e.button === "number" && e.button !== 0) return false;
      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== target.clipId) return false;

      e.stopPropagation();
      setIsPlaying(false);
      selectClip(target.clipId, false);
      clearLiveMaskLayoutPreview();

      const local = toClipLocal(e.global);
      const startLayout = resolveMaskLayoutAtPlayhead(target.maskClip);
      const params = target.maskClip.maskParameters;
      interactionRef.current = {
        active: true,
        mode: "translate",
        clipId: target.clipId,
        maskId: target.maskLocalId,
        handle: null,
        startLocal: local,
        startLayout,
        startBaseSize: {
          width: Math.max(1, params?.baseWidth ?? 1),
          height: Math.max(1, params?.baseHeight ?? 1),
        },
        initialAngle: 0,
        transformIds: resolveMaskLayoutTransformIds(target.maskClip),
        didMove: false,
      };
      notifyLiveMaskLayout(interactionRef.current.transformIds, startLayout);
      setInteractionContext({
        clipId: target.clipId,
        mode: "edit",
        maskId: target.maskLocalId,
      });
      bindStageListeners();
      return true;
    };

    const handleSam2PointPointerDown = (
      e: FederatedPointerEvent,
      target: {
        clipId: string;
        maskClip: MaskTimelineClip;
        maskLocalId: string;
      },
    ): boolean => {
      const button = typeof e.button === "number" ? e.button : 0;
      if (button !== 0 && button !== 2) return false;

      if (button === 2 && typeof e.preventDefault === "function") {
        e.preventDefault();
      }
      e.stopPropagation();
      setIsPlaying(false);
      selectClip(target.clipId, false);
      clearLiveMaskLayoutPreview();

      const local = toClipLocal(e.global);
      const contentSize = resolveActiveClipContentSize();
      const currentInputTime = resolveMaskInputTimeAtPlayhead(target.maskClip);
      const label: 0 | 1 =
        button === 2 ? 0 : sam2PointMode === "remove" ? 0 : 1;
      const nextPoint = toSam2NormalizedPoint(
        local,
        contentSize,
        label,
        currentInputTime,
      );

      updateSam2MaskPoints(target.clipId, target.maskLocalId, (points) => {
        const pointsAtCurrentTime = points
          .map((point, index) => ({ point, index }))
          .filter(
            ({ point }) =>
              Math.abs(point.timeTicks - currentInputTime) <=
              pointTimeEpsilonTicks,
          );

        const nearest = pointsAtCurrentTime.reduce(
          (acc, entry) => {
            const { point, index } = entry;
            const localPoint = toSam2LocalPoint(point, contentSize);
            const dx = local.x - localPoint.x;
            const dy = local.y - localPoint.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq < acc.distanceSq) {
              return { index, distanceSq };
            }
            return acc;
          },
          { index: -1 as number, distanceSq: Number.POSITIVE_INFINITY },
        );

        if (
          nearest.index >= 0 &&
          nearest.distanceSq <= SAM2_POINT_HIT_RADIUS * SAM2_POINT_HIT_RADIUS
        ) {
          return points.filter((_, index) => index !== nearest.index);
        }

        return [...points, nextPoint];
      });

      setInteractionContext({
        clipId: target.clipId,
        mode: "edit",
        maskId: target.maskLocalId,
      });
      return true;
    };

    const onSpritePointerDown = (e: FederatedPointerEvent): boolean => {
      const activeClip = activeClipRef.current;
      if (!activeClip || !viewport) return false;

      const timelineState = useTimelineStore.getState();
      const selectedId = timelineState.selectedClipIds[0] ?? null;
      if (!selectedId || activeClip.id !== selectedId) return false;

      const pendingDraw = useMaskViewStore.getState().pendingDrawRequest;
      if (pendingDraw && pendingDraw.clipId === selectedId) {
        e.stopPropagation();
        setIsPlaying(false);
        selectClip(selectedId, false);
        clearLiveMaskLayoutPreview();

        const local = toClipLocal(e.global);
        interactionRef.current = {
          active: true,
          mode: "draw",
          clipId: selectedId,
          maskId: null,
          handle: null,
          startLocal: local,
          startLayout: null,
          startBaseSize: null,
          initialAngle: 0,
          transformIds: {
            position: null,
            scale: null,
            rotation: null,
          },
          didMove: false,
        };
        setInteractionContext({
          clipId: selectedId,
          mode: "draw",
          maskId: null,
        });
        bindStageListeners();
        return true;
      }

      const sam2Target = getTargetSam2MaskForPointEditing();
      if (sam2Target) {
        return handleSam2PointPointerDown(e, sam2Target);
      }

      const targetMask = getTargetMaskForEditing();
      if (!targetMask) return false;

      const local = toClipLocal(e.global);
      const resolvedMask = resolveMaskForHitTest(targetMask.maskClip);
      if (!isPointInsideMask(local, resolvedMask)) return false;

      return startMaskTranslateInteraction(e, targetMask);
    };

    const onMaskPointerDown = (e: FederatedPointerEvent): boolean => {
      const targetMask = getTargetMaskForEditing();
      if (!targetMask) return false;
      return startMaskTranslateInteraction(e, targetMask);
    };

    const onHandlePointerDown = (e: FederatedPointerEvent, key: string) => {
      const targetMask = getTargetMaskForEditing();
      if (!targetMask) return;

      e.stopPropagation();
      setIsPlaying(false);
      selectClip(targetMask.clipId, false);
      clearLiveMaskLayoutPreview();

      const local = toClipLocal(e.global);
      const mode: MaskInteractionMode = e.altKey ? "rotate" : "scale";
      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== targetMask.clipId) return;
      const layout = resolveMaskLayoutAtPlayhead(targetMask.maskClip);
      const initialAngle = getAngleFromPoint(local, layout);
      const params = targetMask.maskClip.maskParameters;

      interactionRef.current = {
        active: true,
        mode,
        clipId: targetMask.clipId,
        maskId: targetMask.maskLocalId,
        handle: key,
        startLocal: local,
        startLayout: layout,
        startBaseSize: {
          width: Math.max(1, params?.baseWidth ?? 1),
          height: Math.max(1, params?.baseHeight ?? 1),
        },
        initialAngle,
        transformIds: resolveMaskLayoutTransformIds(targetMask.maskClip),
        didMove: false,
      };

      notifyLiveMaskLayout(interactionRef.current.transformIds, layout);
      setInteractionContext({
        clipId: targetMask.clipId,
        mode: "edit",
        maskId: targetMask.maskLocalId,
      });
      bindStageListeners();
    };

    return {
      onSpritePointerDown,
      onMaskPointerDown,
      onHandlePointerDown,
      unbindStageListeners,
    };
  }, [
    activeClipRef,
    addClipMask,
    app,
    clearPendingDraw,
    clearLiveMaskLayoutPreview,
    getTargetMaskForEditing,
    getTargetSam2MaskForPointEditing,
    pointTimeEpsilonTicks,
    renderMaskToOverlay,
    resolveMaskForHitTest,
    resolveMaskInputTimeAtPlayhead,
    resolveMaskLayoutAtPlayhead,
    resolveActiveClipContentSize,
    selectClip,
    setLiveMaskLayoutPreview,
    setInteractionContext,
    setIsPlaying,
    setSelectedMask,
    sam2PointMode,
    toSam2LocalPoint,
    toSam2NormalizedPoint,
    toClipLocal,
    updateClipMask,
    updateSam2MaskPoints,
    viewport,
  ]);

  useEffect(() => {
    if (!viewport) return;

    const clipOverlay = new PixiContainer();
    const maskOverlay = new PixiContainer();
    const maskGraphics = new PixiGraphics();
    const sam2PointsGraphics = new PixiGraphics();
    const sam2PreviewSprite = new PixiSprite();

    // SAM2 preview sprite: semi-transparent blue-tinted mask overlay
    sam2PreviewSprite.anchor.set(0.5);
    sam2PreviewSprite.alpha = 0.45;
    sam2PreviewSprite.tint = SAM2_BORDER_COLOR;
    sam2PreviewSprite.visible = false;
    sam2PreviewSprite.eventMode = "none";

    maskOverlay.addChild(maskGraphics);
    sam2PointsGraphics.eventMode = "none";
    // Add preview sprite first (below points), then points on top
    clipOverlay.addChild(sam2PreviewSprite);
    clipOverlay.addChild(sam2PointsGraphics);
    clipOverlay.addChild(maskOverlay);
    // Keep mask fill above sprites but below gizmo handles.
    clipOverlay.zIndex = 9_998;
    clipOverlay.visible = false;

    viewport.addChild(clipOverlay);

    clipOverlayRef.current = clipOverlay;
    maskOverlayRef.current = maskOverlay;
    maskGraphicsRef.current = maskGraphics;
    sam2PointsGraphicsRef.current = sam2PointsGraphics;
    sam2PreviewSpriteRef.current = sam2PreviewSprite;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGizmoTarget(maskOverlay);

    return () => {
      // Clean up preview sprite texture
      const previewTex = sam2PreviewSprite.texture;
      if (previewTex && previewTex !== Texture.EMPTY && !previewTex.destroyed) {
        previewTex.destroy(true);
      }

      if (viewport && !viewport.destroyed) {
        viewport.removeChild(clipOverlay);
      }
      clipOverlay.destroy({ children: true });
      clipOverlayRef.current = null;
      maskOverlayRef.current = null;
      maskGraphicsRef.current = null;
      sam2PointsGraphicsRef.current = null;
      sam2PreviewSpriteRef.current = null;
      sam2PreviewTextureUrlRef.current = "";
      sam2PreviewBitmapRef.current = null;
      overlayShapeSignatureRef.current = "";
      liveMaskLayoutPreviewRef.current = null;
      setGizmoTarget(null);
      setIsMaskGizmoVisible(false);
    };
  }, [viewport]);

  useEffect(() => {
    const maskGraphics = maskGraphicsRef.current;
    if (!maskGraphics) return;

    // Dragging mask body should follow the same interaction path as sprite drag.
    maskGraphics.eventMode = "static";
    maskGraphics.cursor = "grab";
    maskGraphics.on("pointerdown", handlers.onMaskPointerDown);

    return () => {
      maskGraphics.off("pointerdown", handlers.onMaskPointerDown);
    };
  }, [handlers.onMaskPointerDown, viewport]);

  useEffect(() => {
    if (!app) return;

    const syncSam2EditingCursor = (enabled: boolean) => {
      const maskGraphics = maskGraphicsRef.current;
      if (sprite) {
        if (enabled) {
          if (sprite.cursor !== "crosshair") {
            sprite.cursor = "crosshair";
          }
        } else if (sprite.cursor === "crosshair") {
          sprite.cursor = "grab";
        }
      }

      if (maskGraphics) {
        if (enabled) {
          if (maskGraphics.cursor !== "crosshair") {
            maskGraphics.cursor = "crosshair";
          }
        } else if (maskGraphics.cursor === "crosshair") {
          maskGraphics.cursor = "grab";
        }
      }
    };

    const updateOverlay = () => {
      if (!sprite || !selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      const synced = syncOverlayToSprite();
      if (!synced) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      if (pendingDrawRequest && pendingDrawRequest.clipId === selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(draftMaskShapeRef.current);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      if (!selectedMaskClip) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      if (selectedMaskClip.maskType === "sam2") {
        const isSam2EditorActive = isMaskTabActive;
        syncSam2EditingCursor(isSam2EditorActive);
        renderMaskToOverlay(null);
        if (isSam2EditorActive) {
          renderSam2PointsToOverlay(selectedMaskClip);
          updateSam2PreviewSprite(selectedClipId, selectedMaskClip);
        } else {
          renderSam2PointsToOverlay(null);
          clearSam2PreviewSprite();
        }
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      if (selectedMaskClip.maskType === "generation") {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      syncSam2EditingCursor(false);
      renderSam2PointsToOverlay(null);
      clearSam2PreviewSprite();

      if (selectedMaskClip.maskMode === "off") {
        renderMaskToOverlay(null);
        setIsMaskGizmoVisible((previous) => (previous ? false : previous));
        return;
      }

      const liveMaskLayoutPreview = liveMaskLayoutPreviewRef.current;
      const liveLayout =
        liveMaskLayoutPreview &&
        liveMaskLayoutPreview.clipId === selectedClipId &&
        liveMaskLayoutPreview.maskId === selectedMaskId
          ? liveMaskLayoutPreview.layout
          : null;
      const resolvedLayout =
        liveLayout ?? resolveMaskLayoutAtPlayhead(selectedMaskClip);
      renderMaskToOverlay(selectedMaskClip, resolvedLayout);
      setIsMaskGizmoVisible((previous) => (previous ? previous : true));
    };

    app.ticker.add(updateOverlay);
    updateOverlay();

    return () => {
      app.ticker.remove(updateOverlay);
    };
  }, [
    activeClipRef,
    app,
    clearSam2PreviewSprite,
    pendingDrawRequest,
    renderMaskToOverlay,
    renderSam2PointsToOverlay,
    updateSam2PreviewSprite,
    isMaskTabActive,
    selectedClipId,
    selectedMaskClip,
    selectedMaskId,
    sprite,
    syncOverlayToSprite,
    resolveMaskLayoutAtPlayhead,
  ]);

  useEffect(() => {
    return () => {
      handlers.unbindStageListeners();
    };
  }, [handlers]);

  return {
    onSpritePointerDown: handlers.onSpritePointerDown,
    onMaskPointerDown: handlers.onMaskPointerDown,
    onHandlePointerDown: handlers.onHandlePointerDown,
    gizmoTarget,
    isMaskGizmoVisible,
  };
}
