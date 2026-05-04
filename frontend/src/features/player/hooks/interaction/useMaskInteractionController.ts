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
  livePreviewParamStore,
} from "../../../transformations";
import { hasDragMovement } from "./transformInteraction";
import { playbackClock } from "../../services/PlaybackClock";
import {
  bindStagePointerListeners,
  unbindStagePointerListeners,
} from "./pointerStage";
import {
  computeHandleScale,
  getAngleFromPoint,
  lockCornerScaleAspectRatio,
} from "./layoutInteractionMath";
import { registerCanvasSelectable } from "./useCanvasSelectionManager";
import {
  createMaskLayoutTransforms,
  getMaskLayoutState,
  createMask,
  drawMaskBaseShape,
  isPointInsideMask,
  type MaskLayoutState,
  type MaskShapeSource,
} from "../../../masks/model/maskFactory";
import {
  createMaskRenderableShapeSource,
  getMaskRenderableBaseSize,
} from "../../../masks/model/maskRenderableLayout";
import { resolveMaskLayoutStateAtTime } from "../../../masks/model/maskTimelineClip";
import { useMaskViewStore } from "../../../masks/store/useMaskViewStore";
import {
  ensureBrushBuffer,
  hydrateBrushBufferFromUrl,
  isBrushBufferReadyForSource,
  paintBrushDot,
  paintBrushStroke,
  subscribeToBrushBuffer,
} from "../../../masks/runtime/brushBufferRegistry";
import { flushBrushMaskCommit } from "../../../masks/runtime/brushAssetSync";
import { resolveMaskRenderableLayout } from "../../../masks/runtime/resolveMaskRenderableLayout";
import { ensureAssetSourceLoaded, useAssetStore } from "../../../userAssets";
import { syncContainerTransformToTarget } from "../../../renderer";
import { useProjectStore } from "../../../project/useProjectStore";
import { useCanvasSelectionStore } from "../../useCanvasSelectionStore";

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

type MaskInteractionMode =
  | "idle"
  | "draw"
  | "translate"
  | "scale"
  | "rotate"
  | "brush";

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
  brush: BrushStrokeState | null;
}

interface BrushStrokeState {
  tool: "paint" | "erase";
  lastCanvasPoint: { x: number; y: number };
  canvasSize: { width: number; height: number };
  radius: number;
  /** Local id of the mask (without the parent clip prefix). */
  maskLocalId: string;
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
    brush: null,
  };
}

interface LiveMaskLayoutPreview {
  clipId: string;
  maskId: string;
  layout: MaskLayoutState;
}

interface MaskInteractionTarget {
  clipId: string;
  maskClip: MaskTimelineClip;
  maskLocalId: string;
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
    livePreviewParamStore.set(transformIds.position, "x", layout.x);
    livePreviewParamStore.set(transformIds.position, "y", layout.y);
  }
  if (transformIds.scale) {
    liveParamStore.notify(transformIds.scale, "x", layout.scaleX);
    liveParamStore.notify(transformIds.scale, "y", layout.scaleY);
    livePreviewParamStore.set(transformIds.scale, "x", layout.scaleX);
    livePreviewParamStore.set(transformIds.scale, "y", layout.scaleY);
  }
  if (transformIds.rotation) {
    liveParamStore.notify(transformIds.rotation, "angle", layout.rotation);
    livePreviewParamStore.set(transformIds.rotation, "angle", layout.rotation);
  }
}

function clearLiveMaskLayoutPreviewParams(transformIds: MaskLayoutTransformIds) {
  if (transformIds.position) {
    livePreviewParamStore.clear(transformIds.position, "x");
    livePreviewParamStore.clear(transformIds.position, "y");
  }
  if (transformIds.scale) {
    livePreviewParamStore.clear(transformIds.scale, "x");
    livePreviewParamStore.clear(transformIds.scale, "y");
  }
  if (transformIds.rotation) {
    livePreviewParamStore.clear(transformIds.rotation, "angle");
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
  trackId: string,
  trackZIndex: number,
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
  const activeCanvasSelection = useCanvasSelectionStore(
    (state) => state.activeSelection,
  );
  const selectCanvasClip = useCanvasSelectionStore((state) => state.selectClip);
  const selectCanvasMask = useCanvasSelectionStore((state) => state.selectMask);

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
  const brushTool = useMaskViewStore((state) => state.brushTool);
  const setBrushTool = useMaskViewStore((state) => state.setBrushTool);
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

  const toMaskOverlayLocal = useCallback(
    (global: { x: number; y: number }) => {
      if (!maskOverlayRef.current) return { x: 0, y: 0 };
      return maskOverlayRef.current.toLocal(global);
    },
    [],
  );

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

  const createEditableMaskTarget = useCallback(
    (clipId: string, maskClip: MaskTimelineClip): MaskInteractionTarget | null => {
      const activeClip = activeClipRef.current;
      const parsed = parseMaskClipId(maskClip.id);
      const maskLocalId = parsed?.maskId ?? null;

      if (!activeClip || activeClip.id !== clipId || !maskLocalId) {
        return null;
      }

      if (maskClip.maskType === "sam2") {
        return null;
      }

      if (
        maskClip.maskType === "brush" &&
        useMaskViewStore.getState().brushTool !== "gizmo"
      ) {
        return null;
      }

      return {
        clipId,
        maskClip,
        maskLocalId,
      };
    },
    [activeClipRef],
  );

  const resolveMaskRenderableShape = useCallback(
    (
      maskClip: MaskTimelineClip,
      layoutOverride?: MaskLayoutState,
    ): MaskShapeSource | null => {
      const resolvedLayout = resolveMaskRenderableLayout(maskClip, {
        layout: layoutOverride ?? resolveMaskLayoutAtPlayhead(maskClip),
        parentClipContentSize: resolveActiveClipContentSize(),
      });
      return createMaskRenderableShapeSource(maskClip, resolvedLayout);
    },
    [resolveActiveClipContentSize, resolveMaskLayoutAtPlayhead],
  );

  const resolveMaskHitTestShape = useCallback(
    (maskClip: MaskTimelineClip): MaskShapeSource | null =>
      resolveMaskRenderableShape(maskClip),
    [resolveMaskRenderableShape],
  );

  const resolveMaskLayoutBaseSize = useCallback(
    (maskClip: MaskTimelineClip): { width: number; height: number } =>
      getMaskRenderableBaseSize(resolveMaskRenderableShape(maskClip)),
    [resolveMaskRenderableShape],
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

      const layout =
        layoutOverride ??
        getMaskLayoutState(mask as unknown as ClipMask);
      applyLayoutToOverlay(layout);

      const params = mask.maskParameters ??
        mask.parameters ?? { baseWidth: 1, baseHeight: 1 };
      const shapeType = mask.maskType ?? mask.type ?? "rectangle";
      const isDraft = mask.id === "draft_mask";
      const maskMode = (mask as MaskShapeSource & {
        maskMode?: MaskTimelineClip["maskMode"];
      }).maskMode;

      const shapeSignature = `${mask.id ?? ""}:${shapeType}:${params.baseWidth}:${params.baseHeight}`;
      if (overlayShapeSignatureRef.current !== shapeSignature) {
        graphics.clear();
        drawMaskBaseShape(graphics, {
          ...mask,
          transformations: undefined,
        });
        overlayShapeSignatureRef.current = shapeSignature;
      }
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

  const findEditableMaskTargetAtPoint = useCallback(
    (global: { x: number; y: number }): MaskInteractionTarget | null => {
      const activeClip = activeClipRef.current;
      if (!activeClip) return null;
      if (!syncOverlayToSprite()) return null;

      const timelineState = useTimelineStore.getState();
      const maskClips = selectMaskClipsForParent(timelineState, activeClip.id);
      if (maskClips.length === 0) return null;

      const selectedMaskLocalId =
        useMaskViewStore.getState().selectedMaskByClipId[activeClip.id] ?? null;
      const selectedMaskClip = selectedMaskLocalId
        ? maskClips.find(
            (maskClip) =>
              parseMaskClipId(maskClip.id)?.maskId === selectedMaskLocalId,
          ) ?? null
        : null;
      const orderedMasks = selectedMaskClip
        ? [
            selectedMaskClip,
            ...maskClips
              .filter((maskClip) => maskClip.id !== selectedMaskClip.id)
              .reverse(),
          ]
        : [...maskClips].reverse();
      const local = toClipLocal(global);

      for (const maskClip of orderedMasks) {
        const target = createEditableMaskTarget(activeClip.id, maskClip);
        if (!target) continue;

        const hitTestShape = resolveMaskHitTestShape(maskClip);
        if (hitTestShape && isPointInsideMask(local, hitTestShape)) {
          return target;
        }
      }

      return null;
    },
    [
      activeClipRef,
      createEditableMaskTarget,
      resolveMaskHitTestShape,
      syncOverlayToSprite,
      toClipLocal,
    ],
  );

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

  const getTargetMaskForEditing = useCallback((): MaskInteractionTarget | null => {
    const context = resolveSelectedMaskContext();

    if (
      !context.selectedClipId ||
      !context.selectedMaskClip ||
      !context.maskLocalId
    ) {
      return null;
    }

    return createEditableMaskTarget(
      context.selectedClipId,
      context.selectedMaskClip,
    );
  }, [createEditableMaskTarget]);

  const getTargetBrushMaskForPainting = useCallback((): {
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
    if (context.selectedMaskClip.maskType !== "brush") return null;
    if (!isMaskTabActive) return null;
    const tool = useMaskViewStore.getState().brushTool;
    if (tool !== "paint" && tool !== "erase") return null;

    return {
      clipId: context.selectedClipId,
      maskClip: context.selectedMaskClip,
      maskLocalId: context.maskLocalId,
    };
  }, [activeClipRef, isMaskTabActive]);

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

      if (current.mode === "brush" && current.brush && current.maskId) {
        const local = toMaskOverlayLocal(e.global);
        const next = {
          x: local.x + current.brush.canvasSize.width / 2,
          y: local.y + current.brush.canvasSize.height / 2,
        };
        const last = current.brush.lastCanvasPoint;
        paintBrushStroke(
          current.maskId,
          last.x,
          last.y,
          next.x,
          next.y,
          current.brush.radius,
          current.brush.tool,
        );
        current.brush.lastCanvasPoint = next;
        current.didMove = true;
        return;
      }

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
        const lockedScale = lockCornerScaleAspectRatio(
          current.handle,
          { x: base.scaleX, y: base.scaleY },
          scaleDrag.scale,
        );

        const nextLayout: MaskLayoutState = {
          ...base,
          scaleX: lockedScale.x,
          scaleY: lockedScale.y,
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

      if (current.mode === "brush" && current.brush && current.clipId && current.maskId) {
        const clipId = current.clipId;
        const maskLocalId = current.brush.maskLocalId;

        // Commit on stroke-end so brush masks persist across reloads the same
        // way other asset-backed masks do, while still avoiding per-move
        // asset churn during the stroke itself.
        void flushBrushMaskCommit(current.maskId);

        setInteractionContext({
          clipId,
          mode: "edit",
          maskId: maskLocalId,
        });
        resetInteractionState();
        unbindStageListeners();
        return;
      }

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
          selectCanvasMask(current.clipId, finalMask.id);
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
      clearLiveMaskLayoutPreviewParams(current.transformIds);
      resetInteractionState();
      unbindStageListeners();
    }

    const startMaskTranslateInteraction = (
      e: FederatedPointerEvent,
      target: MaskInteractionTarget,
    ): boolean => {
      if (typeof e.button === "number" && e.button !== 0) return false;
      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== target.clipId) return false;

      e.stopPropagation();
      setIsPlaying(false);
      selectClip(target.clipId, false);
      setSelectedMask(target.clipId, target.maskLocalId);
      selectCanvasMask(target.clipId, target.maskLocalId);
      clearLiveMaskLayoutPreview();

      const local = toClipLocal(e.global);
      const startLayout = resolveMaskLayoutAtPlayhead(target.maskClip);
      const startBaseSize = resolveMaskLayoutBaseSize(target.maskClip);
      renderMaskToOverlay(
        resolveMaskRenderableShape(target.maskClip, startLayout),
      );
      interactionRef.current = {
        active: true,
        mode: "translate",
        clipId: target.clipId,
        maskId: target.maskLocalId,
        handle: null,
        startLocal: local,
        startLayout,
        startBaseSize,
        initialAngle: 0,
        transformIds: resolveMaskLayoutTransformIds(target.maskClip),
        didMove: false,
        brush: null,
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

    const handleBrushPointerDown = (
      e: FederatedPointerEvent,
      target: {
        clipId: string;
        maskClip: MaskTimelineClip;
        maskLocalId: string;
      },
    ): boolean => {
      if (typeof e.button === "number" && e.button !== 0) return false;
      const tool = useMaskViewStore.getState().brushTool;
      if (tool !== "paint" && tool !== "erase") return false;
      const radius = useMaskViewStore.getState().brushRadius;

      e.stopPropagation();
      setIsPlaying(false);
      selectClip(target.clipId, false);
      setSelectedMask(target.clipId, target.maskLocalId);
      selectCanvasMask(target.clipId, target.maskLocalId);
      clearLiveMaskLayoutPreview();

      const params = target.maskClip.maskParameters;
      // Lazy-finalize the brush canvas to the parent clip's content size on
      // first paint. The mask was created with a (1,1) placeholder so we
      // can defer until a frame has decoded and the texture size is known.
      const placeholder =
        (params?.baseWidth ?? 1) <= 1 && (params?.baseHeight ?? 1) <= 1;
      const clipContent = resolveActiveClipContentSize();
      const canvasSize =
        placeholder && clipContent.width > 1 && clipContent.height > 1
          ? {
              width: Math.round(clipContent.width),
              height: Math.round(clipContent.height),
            }
          : {
              width: Math.max(1, Math.round(params?.baseWidth ?? 1)),
              height: Math.max(1, Math.round(params?.baseHeight ?? 1)),
            };
      ensureBrushBuffer(
        target.maskClip.id,
        canvasSize.width,
        canvasSize.height,
      );
      if (
        placeholder &&
        (canvasSize.width !== params?.baseWidth ||
          canvasSize.height !== params?.baseHeight)
      ) {
        // Persist the finalized canvas size so reloads/hydration restore it.
        updateClipMask(target.clipId, target.maskLocalId, {
          maskParameters: {
            baseWidth: canvasSize.width,
            baseHeight: canvasSize.height,
          },
        });
      }

      const local = toMaskOverlayLocal(e.global);
      const point = {
        x: local.x + canvasSize.width / 2,
        y: local.y + canvasSize.height / 2,
      };
      paintBrushDot(target.maskClip.id, point.x, point.y, radius, tool);

      interactionRef.current = {
        active: true,
        mode: "brush",
        clipId: target.clipId,
        maskId: target.maskClip.id,
        handle: null,
        startLocal: local,
        startLayout: null,
        startBaseSize: null,
        initialAngle: 0,
        transformIds: { position: null, scale: null, rotation: null },
        didMove: false,
        brush: {
          tool,
          lastCanvasPoint: point,
          canvasSize,
          radius,
          maskLocalId: target.maskLocalId,
        },
      };
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
      setSelectedMask(target.clipId, target.maskLocalId);
      selectCanvasMask(target.clipId, target.maskLocalId);
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
        selectCanvasClip(selectedId);
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
          brush: null,
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

      const brushTarget = getTargetBrushMaskForPainting();
      if (brushTarget) {
        return handleBrushPointerDown(e, brushTarget);
      }

      const targetMask = findEditableMaskTargetAtPoint(e.global);
      return targetMask ? startMaskTranslateInteraction(e, targetMask) : false;
    };

    const onAnyMaskPointerDown = (e: FederatedPointerEvent): boolean => {
      const targetMask = findEditableMaskTargetAtPoint(e.global);
      return targetMask ? startMaskTranslateInteraction(e, targetMask) : false;
    };

    const onMaskPointerDown = (e: FederatedPointerEvent): boolean => {
      const brushTarget = getTargetBrushMaskForPainting();
      if (brushTarget) {
        return handleBrushPointerDown(e, brushTarget);
      }
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
      setSelectedMask(targetMask.clipId, targetMask.maskLocalId);
      selectCanvasMask(targetMask.clipId, targetMask.maskLocalId);
      clearLiveMaskLayoutPreview();

      const local = toClipLocal(e.global);
      const mode: MaskInteractionMode = e.altKey ? "rotate" : "scale";
      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== targetMask.clipId) return;
      const layout = resolveMaskLayoutAtPlayhead(targetMask.maskClip);
      const initialAngle = getAngleFromPoint(local, layout);
      const startBaseSize = resolveMaskLayoutBaseSize(targetMask.maskClip);

      interactionRef.current = {
        active: true,
        mode,
        clipId: targetMask.clipId,
        maskId: targetMask.maskLocalId,
        handle: key,
        startLocal: local,
        startLayout: layout,
        startBaseSize,
        initialAngle,
        transformIds: resolveMaskLayoutTransformIds(targetMask.maskClip),
        didMove: false,
        brush: null,
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
      onAnyMaskPointerDown,
      onMaskPointerDown,
      onHandlePointerDown,
      unbindStageListeners,
    };
  }, [
    activeClipRef,
    addClipMask,
    app,
    brushTool,
    clearPendingDraw,
    clearLiveMaskLayoutPreview,
    getTargetMaskForEditing,
    getTargetBrushMaskForPainting,
    getTargetSam2MaskForPointEditing,
    findEditableMaskTargetAtPoint,
    pointTimeEpsilonTicks,
    renderMaskToOverlay,
    resolveMaskRenderableShape,
    resolveMaskInputTimeAtPlayhead,
    resolveMaskLayoutAtPlayhead,
    resolveMaskLayoutBaseSize,
    resolveActiveClipContentSize,
    selectClip,
    selectCanvasClip,
    selectCanvasMask,
    setLiveMaskLayoutPreview,
    setInteractionContext,
    setIsPlaying,
    setSelectedMask,
    sam2PointMode,
    toMaskOverlayLocal,
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
    // Keep the selected mask above its own track sprite while still letting
    // higher tracks outrank it during hit testing and rendering.
    clipOverlay.zIndex = trackZIndex + 0.5;
    clipOverlay.visible = false;

    viewport.addChild(clipOverlay);
    viewport.sortChildren();

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
  }, [trackZIndex, viewport]);

  useEffect(() => {
    const maskGraphics = maskGraphicsRef.current;
    if (!maskGraphics) return;

    // Keep direct pointer binding so Pixi hit testing can still select the
    // topmost interactive object on the canvas without depending on stage-wide
    // dispatch.
    maskGraphics.eventMode = "static";
    maskGraphics.cursor = "grab";
    maskGraphics.on("pointerdown", handlers.onMaskPointerDown);

    return () => {
      maskGraphics.off("pointerdown", handlers.onMaskPointerDown);
    };
  }, [handlers.onMaskPointerDown, viewport]);

  useEffect(() => {
    const maskGraphics = maskGraphicsRef.current;
    if (!maskGraphics) return;

    return registerCanvasSelectable({
      id: `mask:${trackId}`,
      kind: "mask",
      displayObject: maskGraphics,
      getClipId: () => selectedClipId,
      getSelectionOrder: () => trackZIndex + 0.5,
      onPointerDown: handlers.onMaskPointerDown,
      isEnabled: () =>
        maskGraphics.visible && !!selectedClipId && !!selectedMaskId,
    });
  }, [
    handlers.onMaskPointerDown,
    selectedClipId,
    selectedMaskId,
    trackId,
    trackZIndex,
    viewport,
  ]);

  useEffect(() => {
    if (!sprite || !selectedClipId) return;

    return registerCanvasSelectable({
      id: `mask-hit:${trackId}`,
      kind: "mask",
      displayObject: sprite,
      getClipId: () => selectedClipId,
      getSelectionOrder: () => trackZIndex + 0.5,
      containsGlobalPoint: (global) =>
        findEditableMaskTargetAtPoint(global) !== null,
      onPointerDown: handlers.onAnyMaskPointerDown,
      isEnabled: () =>
        sprite.visible &&
        !!selectedClipId &&
        activeClipRef.current?.id === selectedClipId,
    });
  }, [
    activeClipRef,
    findEditableMaskTargetAtPoint,
    handlers.onAnyMaskPointerDown,
    selectedClipId,
    sprite,
    trackId,
    trackZIndex,
  ]);

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
      const isActiveMaskSelection =
        activeCanvasSelection?.kind === "mask" &&
        activeCanvasSelection.clipId === selectedClipId &&
        activeCanvasSelection.maskId === selectedMaskId;

      if (!sprite || !selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible(false);
        return;
      }

      const activeClip = activeClipRef.current;
      if (!activeClip || activeClip.id !== selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible(false);
        return;
      }

      const synced = syncOverlayToSprite();
      if (!synced) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible(false);
        return;
      }

      if (pendingDrawRequest && pendingDrawRequest.clipId === selectedClipId) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(draftMaskShapeRef.current);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible(false);
        return;
      }

      if (!selectedMaskClip) {
        syncSam2EditingCursor(false);
        renderMaskToOverlay(null);
        renderSam2PointsToOverlay(null);
        clearSam2PreviewSprite();
        setIsMaskGizmoVisible(false);
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
        setIsMaskGizmoVisible(false);
        return;
      }

      syncSam2EditingCursor(false);
      renderSam2PointsToOverlay(null);
      clearSam2PreviewSprite();

      const liveMaskLayoutPreview = liveMaskLayoutPreviewRef.current;
      const liveLayout =
        liveMaskLayoutPreview &&
        liveMaskLayoutPreview.clipId === selectedClipId &&
        liveMaskLayoutPreview.maskId === selectedMaskId
          ? liveMaskLayoutPreview.layout
          : null;
      const resolvedLayout =
        liveLayout ?? resolveMaskLayoutAtPlayhead(selectedMaskClip);
      const renderableShape = resolveMaskRenderableShape(
        selectedMaskClip,
        resolvedLayout,
      );

      if (selectedMaskClip.maskType === "brush") {
        const tool = useMaskViewStore.getState().brushTool;
        const isPainting = tool === "paint" || tool === "erase";
        syncSam2EditingCursor(isPainting);
        renderMaskToOverlay(renderableShape);
        // Gizmo handles visible only when the gizmo tool is selected.
        setIsMaskGizmoVisible(tool === "gizmo" && isActiveMaskSelection);
        return;
      }

      renderMaskToOverlay(renderableShape);
      setIsMaskGizmoVisible(isActiveMaskSelection);
    };

    app.ticker.add(updateOverlay);
    updateOverlay();

    return () => {
      app.ticker.remove(updateOverlay);
    };
  }, [
    activeClipRef,
    app,
    brushTool,
    clearSam2PreviewSprite,
    pendingDrawRequest,
    renderMaskToOverlay,
    renderSam2PointsToOverlay,
    resolveMaskRenderableShape,
    updateSam2PreviewSprite,
    isMaskTabActive,
    activeCanvasSelection,
    selectedClipId,
    selectedMaskClip,
    selectedMaskId,
    sprite,
    syncOverlayToSprite,
    resolveMaskLayoutAtPlayhead,
  ]);

  // Force a re-render whenever the brush buffer's painted bounds change so
  // the maskOverlay polygon (and gizmo) tracks live painting without
  // depending on a zustand subscription firing.
  const [, setBufferTick] = useState(0);
  useEffect(() => {
    if (!selectedMaskClip || selectedMaskClip.maskType !== "brush") return;
    return subscribeToBrushBuffer(selectedMaskClip.id, () => {
      setBufferTick((tick) => tick + 1);
    });
  }, [selectedMaskClip]);

  useEffect(() => {
    if (!selectedMaskClip || selectedMaskClip.maskType !== "brush") return;
    const maskClipId = selectedMaskClip.id;
    const params = selectedMaskClip.maskParameters;
    const width = Math.max(1, params?.baseWidth ?? 1);
    const height = Math.max(1, params?.baseHeight ?? 1);
    const assetId = selectedMaskClip.brushMaskAssetId;
    const persistedBounds = selectedMaskClip.brushPaintedBounds ?? null;

    // Always ensure the buffer exists at the persisted canvas size — strokes
    // can begin before any asset has been committed.
    const buffer = ensureBrushBuffer(maskClipId, width, height);

    if (!assetId) return;
    if (
      buffer.dirty ||
      isBrushBufferReadyForSource(
        maskClipId,
        assetId,
        width,
        height,
        persistedBounds,
      )
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const hydratedAsset = await ensureAssetSourceLoaded(assetId).catch(
        () => null,
      );
      const asset =
        hydratedAsset ??
        useAssetStore
          .getState()
          .assets.find((candidate) => candidate.id === assetId) ??
        null;
      const url = asset?.src;
      if (!url || cancelled) return;
      try {
        await hydrateBrushBufferFromUrl(
          maskClipId,
          url,
          width,
          height,
          persistedBounds,
          assetId,
        );
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to hydrate brush mask buffer", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedMaskClip]);

  // Leave-detection commit. The brush PNG is persisted only when focus moves
  // off the currently-edited brush mask: switching to a different mask or
  // clip, closing the inspector tab, or unmounting. Leaving brush focus also
  // restores gizmo mode so brush masks become canvas-selectable again.
  const focusedBrushMaskClipIdRef = useRef<string | null>(null);
  useEffect(() => {
    const isFocused =
      isMaskTabActive &&
      !!selectedMaskClip &&
      selectedMaskClip.maskType === "brush";
    const next = isFocused && selectedMaskClip ? selectedMaskClip.id : null;
    const previous = focusedBrushMaskClipIdRef.current;
    if (previous && previous !== next) {
      void flushBrushMaskCommit(previous);
      if (!next) {
        setBrushTool("gizmo");
      }
    }
    focusedBrushMaskClipIdRef.current = next;
  }, [isMaskTabActive, selectedMaskClip, setBrushTool]);

  useEffect(() => {
    return () => {
      handlers.unbindStageListeners();
    };
  }, [handlers]);

  useEffect(() => {
    return () => {
      // Flush any unsaved strokes on unmount so closing the editor doesn't
      // discard in-memory paint.
      const focused = focusedBrushMaskClipIdRef.current;
      if (focused) {
        void flushBrushMaskCommit(focused);
        focusedBrushMaskClipIdRef.current = null;
        useMaskViewStore.getState().setBrushTool("gizmo");
      }
    };
  }, []);

  return {
    onSpritePointerDown: handlers.onSpritePointerDown,
    onMaskPointerDown: handlers.onMaskPointerDown,
    onHandlePointerDown: handlers.onHandlePointerDown,
    gizmoTarget,
    isMaskGizmoVisible,
  };
}
