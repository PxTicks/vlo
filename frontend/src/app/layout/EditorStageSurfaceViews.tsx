/**
 * The components mounted in the editor's stages
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.8).
 *
 * Thin on purpose: a surface is a placement, not a rewrite. Each one renders
 * the feature component the editor has always rendered, through the same
 * barrels, so the stores, services, shortcuts, and renderer ownership behind it
 * are untouched by having become replaceable.
 */
import { Player } from "../../features/player/Player";
import { Timeline } from "../../features/timeline/ui";
import { useEditorStageServices } from "./editorStageServices";

export function PlayerSurface() {
  return <Player />;
}

/**
 * The compact-preview reuse seam: the same player stack with the project-level
 * chrome dropped, so a focused workspace shows the picture without standing up
 * a second Pixi application, decoder lease, and audio graph.
 */
export function CompactPreviewSurface() {
  return <Player chrome="compact" />;
}

export function TimelineSurface() {
  const { scrollContainerRef, clipOverlays } = useEditorStageServices();
  return (
    <Timeline
      scrollContainerRef={scrollContainerRef}
      clipOverlays={clipOverlays}
    />
  );
}
