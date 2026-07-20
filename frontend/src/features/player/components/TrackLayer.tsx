import { memo } from "react";
import { Application, Container } from "pixi.js";
import { useTrackRenderer } from "../hooks/useTrackRenderer";
import type { RenderGroupOrchestrator } from "../../renderer/services/RenderGroupOrchestrator";
import type { AdjustmentEffectResolver } from "../../renderer/services/AdjustmentEffectResolver";
import type { LiveFrameGraphCoordinator } from "../../renderer/services/framePlanning";

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
  adjustmentEffectResolver?: AdjustmentEffectResolver | null;
  liveFrameGraphCoordinator?: LiveFrameGraphCoordinator | null;
  interactionsEnabled?: boolean;
}

function TrackLayerComponent({
  trackId,
  app,
  container,
  zIndex,
  logicalDimensions,
  registerSynchronizedPlaybackRenderer,
  orchestrator,
  adjustmentEffectResolver,
  liveFrameGraphCoordinator,
  interactionsEnabled = true,
}: TrackLayerProps) {
  useTrackRenderer(
    trackId,
    app,
    container,
    zIndex,
    logicalDimensions,
    registerSynchronizedPlaybackRenderer,
    orchestrator,
    adjustmentEffectResolver,
    liveFrameGraphCoordinator,
    interactionsEnabled,
  );
  return null;
}

export const TrackLayer = memo(TrackLayerComponent);
