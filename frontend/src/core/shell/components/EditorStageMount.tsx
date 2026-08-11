/**
 * The shell's end of an editor stage
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.1, §4.8).
 *
 * The mount renders whatever surface the layout kernel resolved for its stage
 * and owns the rules that make swapping one safe:
 *
 * - **Focus.** The surface declares the keyboard region it owns; the mount
 *   claims it on pointer-down capture. Capture runs outside-in, so a stage's
 *   claim lands after the surrounding area's default and wins.
 * - **Shortcuts.** Region-scoped shortcuts are gated on that same ownership, so
 *   releasing it on removal is what stops a shortcut firing at a surface the
 *   shell has already replaced.
 * - **Pointer capture and drags.** A surface that owns pointer-driven editing
 *   declares `cancelInteractions`, which runs before the shell stops rendering
 *   it — once from the store when a composition changes, and again here for
 *   every other way a surface can go away (unregistered, editor unmounted).
 *   Cancellers are required to be idempotent for exactly that reason.
 *
 * One surface per stage: the mount never keeps a replaced surface alive, so a
 * second player or timeline runtime cannot exist behind the visible one.
 */
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Box } from "@mui/material";
import {
  claimEditorRegionFromShell,
  releaseEditorRegionFromShell,
  DATA_EDITOR_REGION,
} from "../editorRegions";
import {
  editorSurfaceRegistry,
  runEditorSurfaceCanceller,
  type EditorSurfaceEntry,
} from "../editorSurfaces";
import type { EditorStage } from "../layout/layoutTypes";
import { useShellLayoutStore } from "../layout/useShellLayoutStore";

export interface EditorStageMountProps {
  readonly stage: EditorStage;
  /**
   * Wraps the mounted surface. The app supplies a per-surface error boundary
   * here so a failing surface cannot take the editor down with it.
   */
  readonly wrap?: (surface: EditorSurfaceEntry, content: ReactNode) => ReactNode;
}

function useResolvedSurface(stage: EditorStage): EditorSurfaceEntry | null {
  const surfaceId = useShellLayoutStore(
    (state) => state.resolved.stages[stage].surfaceId,
  );
  // The kernel answers *which* surface; the registry holds the definition. The
  // two move independently, so the entry is read from the registry rather than
  // copied into layout state. Entries are frozen and identity-stable while
  // registered, which is what makes them safe to snapshot.
  const readEntry = () =>
    surfaceId === null ? null : (editorSurfaceRegistry.get(surfaceId) ?? null);
  return useSyncExternalStore(
    (listener) => editorSurfaceRegistry.subscribe(listener),
    readEntry,
    readEntry,
  );
}

export function EditorStageMount({ stage, wrap }: EditorStageMountProps) {
  const surface = useResolvedSurface(stage);
  const focusRegion = surface?.focusRegion;
  // The stage's own element is its claim on a focus region: it is what the
  // reconciler resolves from a focused descendant, so pointer and DOM focus
  // agree on one identity, and releasing it cannot disturb the identically
  // named claim of a neighbouring area.
  const stageRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!surface) return;
    const claimant = stageRef.current;
    return () => {
      // Never bare: a canceller that throws here would escape React's cleanup,
      // past the surface's own boundary, and take the editor down with it.
      runEditorSurfaceCanceller(surface);
      if (claimant) releaseEditorRegionFromShell(claimant);
    };
  }, [surface]);

  const Surface = surface?.component;
  const content =
    surface && Surface ? <Surface surfaceId={surface.id} stage={stage} /> : null;

  return (
    <Box
      ref={stageRef}
      tabIndex={-1}
      data-shell-stage={stage}
      data-shell-surface={surface?.id}
      {...(focusRegion
        ? {
            [DATA_EDITOR_REGION]: focusRegion,
            onPointerDownCapture: (event: { currentTarget: HTMLDivElement }) =>
              claimEditorRegionFromShell(focusRegion, event.currentTarget),
          }
        : {})}
      sx={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {/* Keyed by surface: a replacement gets a clean subtree, including a
          fresh wrapper. Without it a boundary that caught the outgoing
          surface's crash would still be showing its fallback. */}
      {surface && content ? (
        <Fragment key={surface.id}>
          {wrap?.(surface, content) ?? content}
        </Fragment>
      ) : null}
    </Box>
  );
}
