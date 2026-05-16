import { useEffect, useMemo, useState } from "react";
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
  useTimelineStore,
  useTimelineClipMuteOverlay,
  useTimelineMarkersClipOverlay,
} from "../../features/timeline";
import { useTimelineSelectionStore } from "../../features/timelineSelection";
import { useTimelineKeyframeClipOverlay } from "../../features/transformations";
import {
  AssetBrowser,
  useAssetStore,
  useTimelineAssetRevealClipOverlay,
} from "../../features/userAssets";
import { Player } from "../../features/player/Player";
import { useExtractStore } from "../../features/player/useExtractStore";
import { LeftSidebarPanel } from "./LeftSidebarPanel";
import type { LeftSidebarTab } from "./LeftSidebarPanel";
import { RightSidebarPanel } from "./RightSidebarPanel";
import { ProjectSettingsMenu } from "./ProjectSettingsMenu";

const LEFT_PANEL_WIDTH = 356;
const RIGHT_SIDEBAR_WIDTH = 300;
const TIMELINE_HEIGHT = 280;
const ASSET_DRAG_ACTIVATION_DISTANCE_PX = 1;

const ASSET_AUTO_SCROLL = {
  acceleration: 50,
  interval: 5,
  layoutShiftCompensation: false,
} as const;

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
  const keyframeClipOverlay = useTimelineKeyframeClipOverlay();
  const assetRevealClipOverlay = useTimelineAssetRevealClipOverlay();
  const muteClipOverlay = useTimelineClipMuteOverlay();
  const markersClipOverlay = useTimelineMarkersClipOverlay();
  const [activeLeftSidebarTab, setActiveLeftSidebarTab] =
    useState<LeftSidebarTab>("assets");

  // Default to compact if not set
  const layoutMode = config.layoutMode || "compact";
  const clipOverlays = useMemo(
    () => [
      keyframeClipOverlay,
      assetRevealClipOverlay,
      muteClipOverlay,
      markersClipOverlay,
    ],
    [
      assetRevealClipOverlay,
      keyframeClipOverlay,
      markersClipOverlay,
      muteClipOverlay,
    ],
  );

  // Use the Asset Drag Hook
  const {
    handleAssetDragStart,
    handleAssetDragMove,
    handleAssetDragEnd,
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
        distance: ASSET_DRAG_ACTIVATION_DISTANCE_PX,
      },
    }),
  );

  // --- GRID CONFIGURATION ---
  const gridTemplateColumns = `${LEFT_PANEL_WIDTH}px 1fr ${RIGHT_SIDEBAR_WIDTH}px`;
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
      autoScroll={ASSET_AUTO_SCROLL}
    >
      <CssBaseline />
      <Box
        onMouseDownCapture={() => useTimelineStore.getState().setFocused(false)}
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
          <Box
            sx={{
              display: "flex",
              minWidth: 0,
              flexGrow: 1,
              height: "100%",
            }}
          >
            <LeftSidebarPanel
              activeTab={activeLeftSidebarTab}
              onTabChange={setActiveLeftSidebarTab}
            />
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                flexGrow: 1,
              }}
            >
              {activeLeftSidebarTab === "assets" ? <AssetBrowser /> : null}
            </Box>
          </Box>
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
          onMouseDownCapture={() => useTimelineStore.getState().setFocused(true)}
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
            clipOverlays={clipOverlays}
          />
        </Box>
      </Box>

      <AssetDragOverlay />
    </DndContext>
  );
}
