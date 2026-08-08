import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Tab, Tabs, Typography } from "@mui/material";
import { clearScopeSurface } from "./hostScopes";
import {
  hostScopeRegistry,
  type HostScopeRegistry,
  type ScopeEntry,
} from "./scopeRegistry";
import { useScopeFrame } from "./useScopeFrame";

const DISPLAY_HEIGHT_PX = 220;

interface ScopesViewProps {
  /** The dock keeps inactive views mounted; sampling pauses while hidden. */
  readonly active?: boolean;
  readonly registry?: HostScopeRegistry;
}

export function ScopesView({
  active = true,
  registry = hostScopeRegistry,
}: ScopesViewProps) {
  useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getRevision(),
    () => registry.getRevision(),
  );
  const scopes = registry.list();
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A contributed scope can be disposed while it is showing, so the selection
  // resolves against the live table rather than being trusted as state.
  const selected: ScopeEntry | undefined =
    scopes.find((scope) => scope.id === requestedId) ?? scopes[0];
  const frame = useScopeFrame(active && selected !== undefined);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context || !selected) return;
    clearScopeSurface(context, selected.width, selected.height);
    if (!frame) return;
    try {
      selected.render({
        context,
        width: selected.width,
        height: selected.height,
        frame,
      });
    } catch (error) {
      // One bad scope must not take the dock — or its neighbours — with it.
      // The owning adapter reports the diagnostic; this is the last barrier.
      console.error(`Scope '${selected.id}' failed to render.`, error);
    }
  }, [frame, selected]);

  if (scopes.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          No scopes are registered.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Tabs
        value={selected?.id ?? false}
        onChange={(_, value: string) => setRequestedId(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 34, borderBottom: "1px solid #27272a" }}
      >
        {scopes.map((scope) => (
          <Tab
            key={scope.id}
            value={scope.id}
            label={scope.label}
            sx={{ minHeight: 34, minWidth: 0, px: 1, fontSize: "0.68rem" }}
          />
        ))}
      </Tabs>
      <canvas
        ref={canvasRef}
        data-testid="scope-surface"
        width={selected?.width ?? 1}
        height={selected?.height ?? 1}
        style={{ width: "100%", height: DISPLAY_HEIGHT_PX, display: "block" }}
      />
    </Box>
  );
}
