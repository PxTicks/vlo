import { memo } from "react";
import { Application, Container } from "pixi.js";
import { useTrackRenderer } from "../hooks/useTrackRenderer";

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
}

function TrackLayerComponent({
  trackId,
  app,
  container,
  zIndex,
  logicalDimensions,
  registerSynchronizedPlaybackRenderer,
}: TrackLayerProps) {
  useTrackRenderer(
    trackId,
    app,
    container,
    zIndex,
    logicalDimensions,
    registerSynchronizedPlaybackRenderer,
  );
  return null;
}

export const TrackLayer = memo(TrackLayerComponent);
