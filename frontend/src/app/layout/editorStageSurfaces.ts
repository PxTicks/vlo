/**
 * The editor's own structural surfaces
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.8).
 *
 * The player and the timeline stop being fixed JSX in `EditorLayout` and become
 * registered surfaces the shell mounts into a stage. Nothing about how they
 * work changes; what changes is that a stage now has an answer to "what is
 * mounted here", which is the seam a dedicated workspace composes against.
 *
 * Host-only (plan §6): editor surfaces stay unavailable to extensions until a
 * native canary has proven the lifecycle.
 */
import { editorSurfaceRegistry } from "../../core/shell/editorSurfaces";
import { cancelTimelineInteractions } from "../../features/timeline/ui";
import {
  CompactPreviewSurface,
  PlayerSurface,
  TimelineSurface,
} from "./EditorStageSurfaceViews";

let installed = false;

export function declareEditorStageSurfaces(): void {
  if (installed) return;
  installed = true;

  editorSurfaceRegistry.register({
    id: "host.player",
    title: "Player",
    defaultStage: "main-stage",
    order: 0,
    focusRegion: "canvas",
    component: PlayerSurface,
  });

  editorSurfaceRegistry.register({
    id: "host.compact-preview",
    title: "Preview",
    defaultStage: "main-stage",
    // Never the editor's default: a stage's default is the lowest-ordered
    // surface that registered for it, and the full player wins that.
    order: 10,
    focusRegion: "canvas",
    component: CompactPreviewSurface,
  });

  editorSurfaceRegistry.register({
    id: "host.timeline",
    title: "Timeline",
    defaultStage: "lower-stage",
    order: 0,
    focusRegion: "timeline",
    // The timeline owns clip drags, trims, and pointer captures; none of them
    // may outlive the surface they were aimed at.
    cancelInteractions: cancelTimelineInteractions,
    component: TimelineSurface,
  });
}
