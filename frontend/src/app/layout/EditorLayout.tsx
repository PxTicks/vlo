import type { ReactNode } from "react";
import { Box } from "@mui/material";
import { useShallow } from "zustand/react/shallow";
import { EditorStageMount } from "../../core/shell/components/EditorStageMount";
import { RegionSeparator } from "../../core/shell/components/RegionSeparator";
import { WorkspaceChrome } from "../../core/shell/components/WorkspaceChrome";
import type { EditorSurfaceEntry } from "../../core/shell/editorSurfaces";
import {
  RESPONSIVE_SIDEBAR_BREAKPOINT_PX,
  type ResponsiveSidebarRegion,
} from "../../core/shell/layout/layoutTypes";
import { useShellLayoutRuntime } from "../../core/shell/layout/useShellLayoutRuntime";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import { ShellPortableViewHost } from "../../core/shell/ShellPortableViewHost";
import type { ShellViewEntry } from "../../core/shell/viewRegistry";
import type { ProjectConfig } from "../../features/project";
import { useEditorFocusStore } from "../../features/editorFocus";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EditorRegion } from "./EditorRegion";
import { LEFT_SIDEBAR_RAIL_WIDTH_PX } from "./LeftSidebarPanel";

const COLLAPSED_EDGE_RAIL_SIZE_PX = 8;

/**
 * A portable panel renders from the shell's stable host rather than from inside
 * the region showing it, so it needs its own boundary: a crash must take down
 * one panel, not the editor that hosts it.
 */
function wrapPortableView(view: ShellViewEntry, content: ReactNode) {
  return (
    <ErrorBoundary boundaryName={view.title} variant="panel">
      {content}
    </ErrorBoundary>
  );
}

/**
 * A stage is one surface wide, so its boundary is the surface's. Naming it
 * after the surface keeps a crash attributable to whatever is mounted rather
 * than to the stage that happens to hold it.
 */
function wrapStageSurface(surface: EditorSurfaceEntry, content: ReactNode) {
  return (
    <ErrorBoundary boundaryName={surface.title} variant="region">
      {content}
    </ErrorBoundary>
  );
}

interface EditorLayoutProps {
  readonly layoutMode?: ProjectConfig["layoutMode"];
  readonly nonTimelineRegionsLocked: boolean;
  readonly leftSidebar: ReactNode;
  readonly topBar: ReactNode;
  /** Shell region beside the player; renders nothing when it holds no views. */
  readonly playerAside?: ReactNode;
  /** Shell region under the player; renders nothing while it is closed. */
  readonly bottomDock?: ReactNode;
  readonly rightSidebar: ReactNode;
}

export function EditorLayout({
  layoutMode = "compact",
  nonTimelineRegionsLocked,
  leftSidebar,
  topBar,
  playerAside,
  bottomDock,
  rightSidebar,
}: EditorLayoutProps) {
  useShellLayoutRuntime();
  const geometry = useShellLayoutStore(
    useShallow((state) => ({
      left: state.resolved.regions["left-sidebar"],
      right: state.resolved.regions["right-sidebar"],
      lower: state.resolved.lowerStage,
      viewportWidthPx: state.viewport?.widthPx ?? null,
      setRegionCollapsed: state.setRegionCollapsed,
    })),
  );
  const clearRegion = useEditorFocusStore((state) => state.setRegion);
  const leftWidthPx = geometry.left.collapsed
    ? LEFT_SIDEBAR_RAIL_WIDTH_PX
    : geometry.left.sizePx;
  const rightWidthPx = geometry.right.collapsed
    ? COLLAPSED_EDGE_RAIL_SIZE_PX
    : geometry.right.sizePx;
  const lowerHeightPx = geometry.lower.collapsed
    ? COLLAPSED_EDGE_RAIL_SIZE_PX
    : geometry.lower.sizePx;
  const useResponsiveOverlays =
    geometry.viewportWidthPx !== null &&
    geometry.viewportWidthPx < RESPONSIVE_SIDEBAR_BREAKPOINT_PX;
  const responsiveOpenRegion: ResponsiveSidebarRegion | null =
    !useResponsiveOverlays
      ? null
      : !geometry.left.collapsed
        ? "left-sidebar"
        : !geometry.right.collapsed
          ? "right-sidebar"
          : null;
  const gridTemplateColumns = useResponsiveOverlays
    ? "0px minmax(0, 1fr) 0px"
    : `${leftWidthPx}px minmax(0, 1fr) ${rightWidthPx}px`;
  const gridTemplateRows = `48px minmax(0, 1fr) ${lowerHeightPx}px`;
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
    <Box
      data-testid="editor-layout"
      onPointerDownCapture={() => clearRegion(null)}
      sx={{
        display: "grid",
        gridTemplateColumns,
        gridTemplateRows,
        gridTemplateAreas: gridAreas,
        height: "100vh",
        width: "100vw",
        position: "relative",
        bgcolor: "#121212",
        overflow: "hidden",
      }}
    >
      {/* Above the regions, so a panel keeps its subtree, its subscriptions,
          and its rendering surface when the user moves it (plan §3.6). */}
      <ShellPortableViewHost wrap={wrapPortableView} />

      <EditorRegion
        id="shell-region-left-sidebar"
        tabIndex={-1}
        area="left"
        blocked={nonTimelineRegionsLocked}
        overlayTestId="editor-lock-left"
        sx={{
          bgcolor: "#121212",
          borderRight: "1px solid #333",
          display: "flex",
          flexDirection: "column",
          zIndex: 20,
          overflow: "hidden",
          ...(useResponsiveOverlays
            ? {
                position: "absolute",
                gridArea: "auto",
                inset: `0 auto ${layoutMode === "compact" ? lowerHeightPx : 0}px 0`,
                width: leftWidthPx,
                boxShadow: "8px 0 20px rgba(0, 0, 0, 0.28)",
              }
            : {}),
        }}
      >
        <Box
          data-testid="shell-region-left-sidebar-content"
          sx={{
            display: "flex",
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
          {leftSidebar}
        </Box>
        <RegionSeparator
          region="left-sidebar"
          label="Left sidebar"
          edge="right"
          controls="shell-region-left-sidebar"
        />
      </EditorRegion>

      {responsiveOpenRegion !== null ? (
        <Box
          data-testid="responsive-layout-scrim"
          aria-hidden="true"
          onClick={() =>
            geometry.setRegionCollapsed(responsiveOpenRegion, true)
          }
          sx={{
            position: "absolute",
            inset: `0 0 ${layoutMode === "compact" ? lowerHeightPx : 0}px`,
            zIndex: 15,
            bgcolor: "rgba(0, 0, 0, 0.38)",
          }}
        />
      ) : null}

      <EditorRegion
        area="top"
        blocked={nonTimelineRegionsLocked}
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
        {topBar}
        {/* Shell-owned escape chrome is outside every feature surface and its
            error boundary, so a crashed workspace view cannot trap the user. */}
        <WorkspaceChrome />
      </EditorRegion>

      <EditorRegion
        area="player"
        focusRegion="canvas"
        blocked={nonTimelineRegionsLocked}
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
        {/* The player keeps `height: 100%` inside these wrappers, and both
            shell regions collapse to nothing when empty, so an editor with no
            aside or dock lays out exactly as it did without them. */}
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
          }}
        >
          <Box sx={{ display: "flex", flexGrow: 1, minHeight: 0 }}>
            <Box sx={{ display: "flex", flexGrow: 1, minWidth: 0 }}>
              <EditorStageMount stage="main-stage" wrap={wrapStageSurface} />
            </Box>
            {playerAside}
          </Box>
          {bottomDock}
        </Box>
      </EditorRegion>

      <EditorRegion
        id="shell-region-right-sidebar"
        tabIndex={-1}
        area="right"
        focusRegion="inspector"
        blocked={nonTimelineRegionsLocked}
        overlayTestId="editor-lock-right"
        sx={{
          bgcolor: "#121212",
          borderLeft: "1px solid #333",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          zIndex: 20,
          ...(useResponsiveOverlays
            ? {
                position: "absolute",
                gridArea: "auto",
                inset: `0 0 ${layoutMode === "compact" ? lowerHeightPx : 0}px auto`,
                width: rightWidthPx,
                boxShadow: "-8px 0 20px rgba(0, 0, 0, 0.28)",
              }
            : {}),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Box
          data-testid="shell-region-right-sidebar-content"
          aria-hidden={geometry.right.collapsed}
          sx={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minHeight: 0,
            overflow: "hidden",
            visibility: geometry.right.collapsed ? "hidden" : "visible",
          }}
        >
          {rightSidebar}
        </Box>
        <RegionSeparator
          region="right-sidebar"
          label="Right sidebar"
          edge="left"
          controls="shell-region-right-sidebar"
        />
      </EditorRegion>

      {/* Keyboard ownership of the lower stage belongs to whatever surface is
          mounted in it, so the stage mount claims it rather than this frame. */}
      <Box
        id="shell-region-lower-stage"
        sx={{
          gridArea: "bottom",
          bgcolor: "#000",
          zIndex: 10,
          borderTop: "1px solid #333",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <Box
          aria-hidden={geometry.lower.collapsed}
          sx={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minHeight: 0,
            visibility: geometry.lower.collapsed ? "hidden" : "visible",
          }}
        >
          <EditorStageMount stage="lower-stage" wrap={wrapStageSurface} />
        </Box>
        <RegionSeparator
          region="lower-stage"
          label="Timeline"
          edge="top"
          controls="shell-region-lower-stage"
        />
      </Box>
    </Box>
  );
}
