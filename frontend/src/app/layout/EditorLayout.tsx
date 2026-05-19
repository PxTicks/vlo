import type { MouseEventHandler, ReactNode } from "react";
import { Box } from "@mui/material";
import type { ProjectConfig } from "../../features/project";
import { EditorRegion } from "./EditorRegion";

const LEFT_PANEL_WIDTH = 356;
const RIGHT_SIDEBAR_WIDTH = 300;
const TIMELINE_HEIGHT = 280;

interface EditorLayoutProps {
  readonly layoutMode?: ProjectConfig["layoutMode"];
  readonly nonTimelineRegionsLocked: boolean;
  readonly leftSidebar: ReactNode;
  readonly topBar: ReactNode;
  readonly player: ReactNode;
  readonly rightSidebar: ReactNode;
  readonly timeline: ReactNode;
  readonly onEditorMouseDownCapture?: MouseEventHandler<HTMLDivElement>;
  readonly onTimelineMouseDownCapture?: MouseEventHandler<HTMLDivElement>;
}

export function EditorLayout({
  layoutMode = "compact",
  nonTimelineRegionsLocked,
  leftSidebar,
  topBar,
  player,
  rightSidebar,
  timeline,
  onEditorMouseDownCapture,
  onTimelineMouseDownCapture,
}: EditorLayoutProps) {
  const gridTemplateColumns = `${LEFT_PANEL_WIDTH}px 1fr ${RIGHT_SIDEBAR_WIDTH}px`;
  const gridTemplateRows = `48px 1fr ${TIMELINE_HEIGHT}px`;
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
      onMouseDownCapture={onEditorMouseDownCapture}
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
      <EditorRegion
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
        }}
      >
        {leftSidebar}
      </EditorRegion>

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
      </EditorRegion>

      <EditorRegion
        area="player"
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
        {player}
      </EditorRegion>

      <EditorRegion
        area="right"
        blocked={nonTimelineRegionsLocked}
        overlayTestId="editor-lock-right"
        sx={{
          bgcolor: "#121212",
          borderLeft: "1px solid #333",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          zIndex: 20,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {rightSidebar}
      </EditorRegion>

      <Box
        onMouseDownCapture={onTimelineMouseDownCapture}
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
        {timeline}
      </Box>
    </Box>
  );
}
