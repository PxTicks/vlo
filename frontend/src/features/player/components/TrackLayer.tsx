import { memo } from "react";
import { Application, Container } from "pixi.js";
import { useTrackRenderer } from "../hooks/useTrackRenderer";
import type { RenderGroupOrchestrator } from "../../renderer/services/RenderGroupOrchestrator";

interface TrackLayerProps {
  trackId: string;
  app: Application;
  container: Container;
  zIndex: number;
  logicalDimensions: { width: number; height: number };
  registerSynchronizedPlaybackRenderer?: (
    trackId: string,
    renderer: ((time: number) => Promise<void>) | null,
  ) => void;
  orchestrator?: RenderGroupOrchestrator | null;
}

function TrackLayerComponent({
  trackId,
  app,
  container,
  zIndex,
  logicalDimensions,
  registerSynchronizedPlaybackRenderer,
  orchestrator,
}: TrackLayerProps) {
  useTrackRenderer(
    trackId,
    app,
    container,
    zIndex,
    logicalDimensions,
    registerSynchronizedPlaybackRenderer,
    orchestrator,
  );
  return null;
}

export const TrackLayer = memo(TrackLayerComponent);
