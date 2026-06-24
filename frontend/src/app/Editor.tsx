import { useCallback } from "react";
import { CssBaseline } from "@mui/material";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useProjectStore } from "../features/project";
import {
  AssetDragOverlay,
  Timeline,
  useAssetDrag,
} from "../features/timeline";
import { TransformationDragOverlay } from "../features/transformations/components/TransformationDragOverlay";
import { useTransformDrag } from "../features/transformations/hooks/useTransformDrag";
import {
  TransitionDragOverlay,
  useTransitionDrag,
} from "../features/transitions";
import { useEditorFocusReconciler } from "../features/editorFocus";
import { Player } from "../features/player/Player";
import { EditorLayout } from "./layout/EditorLayout";
import { EditorLeftSidebar } from "./layout/EditorLeftSidebar";
import { EditorTopBar } from "./layout/EditorTopBar";
import { RightSidebarPanel } from "./layout/RightSidebarPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useEditorAssetLibrary } from "./hooks/useEditorAssetLibrary";
import { useEditorClipOverlays } from "./hooks/useEditorClipOverlays";
import { useEditorSelectionLock } from "./hooks/useEditorSelectionLock";
import { useEditorOrchestration } from "./orchestration/useEditorOrchestration";

const ASSET_DRAG_ACTIVATION_DISTANCE_PX = 1;

const ASSET_AUTO_SCROLL = {
  acceleration: 50,
  interval: 5,
  layoutShiftCompensation: false,
} as const;

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
      collisionDetection={pointerWithin}
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
    </DndContext>
  );
}
