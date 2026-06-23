import { useDebugStore } from "../../../../shared/debug/useDebugStore";
import type { FramePlanningDiagnostics } from "./framePlanningTypes";

let latest: FramePlanningDiagnostics | null = null;
const listeners = new Set<(diagnostics: FramePlanningDiagnostics) => void>();

export function publishFramePlanningDiagnostics(
  diagnostics: FramePlanningDiagnostics,
): void {
  if (!useDebugStore.getState().debugMode) {
    return;
  }
  latest = diagnostics;
  for (const listener of listeners) {
    listener(diagnostics);
  }
}

export function getLatestFramePlanningDiagnostics(): FramePlanningDiagnostics | null {
  return latest;
}

export function subscribeFramePlanningDiagnostics(
  listener: (diagnostics: FramePlanningDiagnostics) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearFramePlanningDiagnostics(): void {
  latest = null;
}
