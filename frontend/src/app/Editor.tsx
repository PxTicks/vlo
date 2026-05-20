import { CssBaseline } from "@mui/material";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useProjectStore } from "../features/project";
import {
  AssetDragOverlay,
  Timeline,
  useAssetDrag,
  useTimelineStore,
} from "../features/timeline";
import { Player } from "../features/player/Player";
import { EditorLayout } from "./layout/EditorLayout";
import { EditorLeftSidebar } from "./layout/EditorLeftSidebar";
import { EditorTopBar } from "./layout/EditorTopBar";
import { RightSidebarPanel } from "./layout/RightSidebarPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useEditorAssetLibrary } from "./hooks/useEditorAssetLibrary";
import { useEditorClipOverlays } from "./hooks/useEditorClipOverlays";
import { useEditorSelectionLock } from "./hooks/useEditorSelectionLock";

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

  useEditorAssetLibrary();

  const {
    handleAssetDragStart,
    handleAssetDragMove,
    handleAssetDragEnd,
    scrollContainerRef,
  } = useAssetDrag();

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
      onDragStart={handleAssetDragStart}
      onDragMove={handleAssetDragMove}
      onDragEnd={handleAssetDragEnd}
      autoScroll={ASSET_AUTO_SCROLL}
    >
      <CssBaseline />
      <EditorLayout
        layoutMode={layoutMode}
        nonTimelineRegionsLocked={nonTimelineRegionsLocked}
        onEditorMouseDownCapture={() =>
          useTimelineStore.getState().setFocused(false)
        }
        onTimelineMouseDownCapture={() =>
          useTimelineStore.getState().setFocused(true)
        }
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
    </DndContext>
  );
}
