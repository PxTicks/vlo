import { useEffect } from "react";
import type { MouseEventHandler, ReactNode } from "react";
import { Box, CssBaseline } from "@mui/material";
import {
  DndContext,
  pointerWithin,
  useSensors,
  useSensor,
  PointerSensor,
} from "@dnd-kit/core";
import { useProjectStore, ProjectTitle } from "../../features/project";
import {
  Timeline,
  useAssetDrag,
  AssetDragOverlay,
} from "../../features/timeline";
import { useTimelineSelectionStore } from "../../features/timelineSelection";
import { AssetBrowser, useAssetStore } from "../../features/userAssets";
import { Player } from "../../features/player/Player";
import { useExtractStore } from "../../features/player/useExtractStore";
import { RightSidebarPanel } from "./RightSidebarPanel";

const SIDEBAR_WIDTH = 300;
const TIMELINE_HEIGHT = 280;
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";

interface EditorRegionProps {
  area: string;
  blocked: boolean;
  children: ReactNode;
  overlayTestId?: string;
  sx?: Record<string, unknown>;
  overlaySx?: Record<string, unknown>;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
}

function EditorRegion({
  area,
  blocked,
  children,
  overlayTestId,
  sx,
  overlaySx,
  onMouseDown,
}: EditorRegionProps) {
  return (
    <Box
      sx={{
        gridArea: area,
        position: "relative",
        ...sx,
      }}
      onMouseDown={onMouseDown}
    >
      {children}
      {blocked ? (
        <Box
          data-testid={overlayTestId}
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            bgcolor: "rgba(8, 8, 8, 0.52)",
            backdropFilter: "grayscale(0.35)",
            cursor: "not-allowed",
            ...overlaySx,
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : null}
    </Box>
  );
}

export function EditorLayout() {
  const project = useProjectStore((state) => state.project);
  const config = useProjectStore((state) => state.config);
  const fetchAssets = useAssetStore((state) => state.fetchAssets);
  const selectionMode = useTimelineSelectionStore((state) => state.selectionMode);
  const frameSelectionMode = useExtractStore(
    (state) => state.frameSelectionMode,
  );
  const selectionOverlayActive = selectionMode || frameSelectionMode;

  // Default to compact if not set
  const layoutMode = config.layoutMode || "compact";

  // Use the Asset Drag Hook
  const {
    handleAssetDragStart,
    handleAssetDragMove,
    handleAssetDragEnd,
    insertGapIndex,
    scrollContainerRef,
  } = useAssetDrag();

  // Load assets when project is ready
  useEffect(() => {
    if (project?.id && project.rootAssetsFolder) {
      fetchAssets().then(() => {
        useAssetStore.getState().scanForNewAssets();
      });
    }
  }, [project?.id, project?.rootAssetsFolder, fetchAssets]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 3,
      },
    }),
  );

  // --- GRID CONFIGURATION ---
  const gridTemplateColumns = `${SIDEBAR_WIDTH}px 1fr ${SIDEBAR_WIDTH}px`;
  // Row 1: Top Bar (48px)
  // Row 2: Middle (Flex)
  // Row 3: Bottom (Timeline Height)
  const gridTemplateRows = `48px 1fr ${TIMELINE_HEIGHT}px`;

  // Define areas based on mode
  const gridAreas =
    layoutMode === "full-height"
      ? `
        "left top right"
        "left player right"
        "left bottom right"
      `
      : `
        "left top right"
        "left player right"
        "bottom bottom bottom"
      `;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleAssetDragStart}
      onDragMove={handleAssetDragMove}
      onDragEnd={handleAssetDragEnd}
      autoScroll={{
        acceleration: 50,
        interval: 5,
        layoutShiftCompensation: false,
      }}
    >
      <CssBaseline />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns,
          gridTemplateRows,
          gridTemplateAreas: gridAreas,
          height: "100vh",
          width: "100vw",
          bgcolor: "#121212",
          overflow: "hidden",
        }}
      >
        {/* --- LEFT SIDEBAR --- */}
        <EditorRegion
          area="left"
          blocked={selectionOverlayActive}
          overlayTestId="editor-lock-left"
          sx={{
            bgcolor: "#121212",
            borderRight: "1px solid #333",
            display: "flex",
            flexDirection: "column",
            zIndex: 20,
            overflow: "hidden",
          }}
        >
          <AssetBrowser />
        </EditorRegion>

        {/* --- TOP BAR --- */}
        <EditorRegion
          area="top"
          blocked={selectionOverlayActive}
          overlayTestId="editor-lock-top"
          sx={{
            bgcolor: "#000000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderBottom: "1px solid #333",
            zIndex: 10,
          }}
        >
          <ProjectTitle />
          <Box sx={{ position: "absolute", right: 8 }}>
            <ProjectSettingsMenu />
          </Box>
        </EditorRegion>

        {/* --- PLAYER --- */}
        <EditorRegion
          area="player"
          blocked={selectionOverlayActive}
          overlayTestId="editor-lock-player"
          sx={{
            bgcolor: "#2b2b2b",
            overflow: "hidden",
          }}
          overlaySx={{
            bgcolor: "transparent",
            backdropFilter: "none",
          }}
        >
          <Player />
        </EditorRegion>

        {/* --- RIGHT SIDEBAR --- */}
        <EditorRegion
          area="right"
          blocked={selectionOverlayActive}
          overlayTestId="editor-lock-right"
          sx={{
            bgcolor: "#121212",
            borderLeft: "1px solid #333",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            zIndex: 20,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <RightSidebarPanel />
        </EditorRegion>

        {/* --- TIMELINE (BOTTOM) --- */}
        <Box
          sx={{
            gridArea: "bottom",
            bgcolor: "#000",
            zIndex: 10,
            borderTop: "1px solid #333",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Timeline
            scrollContainerRef={scrollContainerRef}
            insertGapIndex={insertGapIndex}
          />
        </Box>
      </Box>

      <AssetDragOverlay />
    </DndContext>
  );
}
