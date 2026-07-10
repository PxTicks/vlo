import { useCallback } from "react";
import { CssBaseline } from "@mui/material";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useProjectStore } from "../features/project";
import {
  COMFYUI_CANVAS_DROP_ID,
  COMFYUI_EDITOR_DROP_SINK_ID,
} from "../features/generation";
import {
  AssetDragOverlay,
  Timeline,
  useAssetDrag,
} from "../features/timeline/ui";
import { TransformationDragOverlay } from "../features/transformations/components/TransformationDragOverlay";
import { useTransformDrag } from "../features/transformations/hooks/useTransformDrag";
import {
  TransitionDragOverlay,
  useTransitionDrag,
} from "../features/transitions";
import { useEditorFocusReconciler } from "../features/editorFocus";
import { Player } from "../features/player/Player";
import { EditorLayout } from "./layout/EditorLayout";
import { HighVramWorkflowPrompt } from "./layout/HighVramWorkflowPrompt";
import { EditorLeftSidebar } from "./layout/EditorLeftSidebar";
import { EditorTopBar } from "./layout/EditorTopBar";
import { RightSidebarPanel } from "./layout/RightSidebarPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useEditorAssetLibrary } from "./hooks/useEditorAssetLibrary";
import { useEditorClipOverlays } from "./hooks/useEditorClipOverlays";
import { useEditorSelectionLock } from "./hooks/useEditorSelectionLock";
import { useEditorOrchestration } from "./orchestration/useEditorOrchestration";
import { registerColorGradingCustomControls } from "../features/colorGrading";

registerColorGradingCustomControls();

const ASSET_DRAG_ACTIVATION_DISTANCE_PX = 1;

const ASSET_AUTO_SCROLL = {
  acceleration: 50,
  interval: 5,
  layoutShiftCompensation: false,
} as const;

// The fullscreen ComfyUI editor overlays the whole app, but the droppables
// underneath (timeline tracks, panel slots) keep their measured rects. Its
// drop layers only mount while a drag is active over the open editor, so when
// the pointer is within one of them it must win outright — the canvas zone
// first, then the sink that swallows everything else.
const collisionDetectionWithComfyPriority: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const priorityCollision =
    collisions.find((collision) => collision.id === COMFYUI_CANVAS_DROP_ID) ??
    collisions.find(
      (collision) => collision.id === COMFYUI_EDITOR_DROP_SINK_ID,
    );
  return priorityCollision ? [priorityCollision] : collisions;
};

export function Editor() {
  const layoutMode = useProjectStore(
    (state) => state.config.layoutMode || "compact",
  );
  const nonTimelineRegionsLocked = useEditorSelectionLock();
  const clipOverlays = useEditorClipOverlays();

  useEditorFocusReconciler();
  useEditorOrchestration();
  useEditorAssetLibrary();

  const {
    handleAssetDragStart,
    handleAssetDragMove,
    handleAssetDragEnd,
    scrollContainerRef,
  } = useAssetDrag();
  const {
    handleTransformDragStart,
    handleTransformDragMove,
    handleTransformDragEnd,
    handleTransformDragCancel,
  } = useTransformDrag(scrollContainerRef);
  const {
    handleTransitionDragStart,
    handleTransitionDragMove,
    handleTransitionDragEnd,
    handleTransitionDragCancel,
  } = useTransitionDrag(scrollContainerRef);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (event.active.data.current?.type === "transform") {
        handleTransformDragStart(event);
        return;
      }
      if (event.active.data.current?.type === "transition") {
        handleTransitionDragStart(event);
        return;
      }
      handleAssetDragStart(event);
    },
    [
      handleAssetDragStart,
      handleTransformDragStart,
      handleTransitionDragStart,
    ],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      if (event.active.data.current?.type === "transform") {
        handleTransformDragMove(event);
        return;
      }
      if (event.active.data.current?.type === "transition") {
        handleTransitionDragMove(event);
        return;
      }
      handleAssetDragMove(event);
    },
    [
      handleAssetDragMove,
      handleTransformDragMove,
      handleTransitionDragMove,
    ],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.active.data.current?.type === "transform") {
        handleTransformDragEnd(event);
        return;
      }
      if (event.active.data.current?.type === "transition") {
        handleTransitionDragEnd(event);
        return;
      }
      handleAssetDragEnd(event);
    },
    [handleAssetDragEnd, handleTransformDragEnd, handleTransitionDragEnd],
  );

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      if (event.active.data.current?.type === "transform") {
        handleTransformDragCancel(event);
        return;
      }
      if (event.active.data.current?.type === "transition") {
        handleTransitionDragCancel(event);
      }
    },
    [handleTransformDragCancel, handleTransitionDragCancel],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: ASSET_DRAG_ACTIVATION_DISTANCE_PX,
      },
    }),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionWithComfyPriority}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      autoScroll={ASSET_AUTO_SCROLL}
    >
      <CssBaseline />
      <EditorLayout
        layoutMode={layoutMode}
        nonTimelineRegionsLocked={nonTimelineRegionsLocked}
        leftSidebar={
          <ErrorBoundary boundaryName="Left sidebar" variant="region">
            <EditorLeftSidebar />
          </ErrorBoundary>
        }
        topBar={
          <ErrorBoundary boundaryName="Top bar" variant="region">
            <EditorTopBar />
          </ErrorBoundary>
        }
        player={
          <ErrorBoundary boundaryName="Player" variant="region">
            <Player />
          </ErrorBoundary>
        }
        rightSidebar={
          <ErrorBoundary boundaryName="Right sidebar" variant="region">
            <RightSidebarPanel />
          </ErrorBoundary>
        }
        timeline={
          <ErrorBoundary boundaryName="Timeline" variant="region">
            <Timeline
              scrollContainerRef={scrollContainerRef}
              clipOverlays={clipOverlays}
            />
          </ErrorBoundary>
        }
      />

      <AssetDragOverlay />
      <TransformationDragOverlay />
      <TransitionDragOverlay />
      <HighVramWorkflowPrompt />
    </DndContext>
  );
}
