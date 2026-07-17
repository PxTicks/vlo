import { registerProjectClosingHook } from "../../../core/project/projectLifecycleHooks";

export interface CompositeSourcePresentationCommit {
  epoch: number;
  placementId: string;
  compositeId: string;
  revision: number;
  mode: "live" | "baked";
  assetId: string | null;
}

export interface CompositeSourcePresentationTarget {
  compositeId: string;
  revision: number;
  assetId: string;
}

const latestByCompositeId = new Map<
  string,
  CompositeSourcePresentationCommit
>();
const listeners = new Set<(commit: CompositeSourcePresentationCommit) => void>();
const cancelWaiters = new Set<() => void>();

function matchesTarget(
  commit: CompositeSourcePresentationCommit | undefined,
  target: CompositeSourcePresentationTarget,
): boolean {
  return Boolean(
    commit &&
      commit.compositeId === target.compositeId &&
      commit.revision === target.revision &&
      commit.mode === "baked" &&
      commit.assetId === target.assetId,
  );
}

export function publishCompositeSourcePresentations(
  commits: readonly CompositeSourcePresentationCommit[],
): void {
  for (const commit of commits) {
    latestByCompositeId.set(commit.compositeId, commit);
    for (const listener of listeners) {
      listener(commit);
    }
  }
}

export function waitForCompositeSourcePresentation(
  target: CompositeSourcePresentationTarget,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (matchesTarget(latestByCompositeId.get(target.compositeId), target)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (presented: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      listeners.delete(onCommit);
      cancelWaiters.delete(cancel);
      resolve(presented);
    };
    const cancel = () => finish(false);
    const onCommit = (commit: CompositeSourcePresentationCommit) => {
      if (matchesTarget(commit, target)) {
        finish(true);
      }
    };
    const timeout = setTimeout(
      () => finish(false),
      Math.max(0, timeoutMs),
    );
    listeners.add(onCommit);
    cancelWaiters.add(cancel);
  });
}

export function resetCompositeSourcePresentations(): void {
  for (const cancel of [...cancelWaiters]) {
    cancel();
  }
  latestByCompositeId.clear();
  listeners.clear();
  cancelWaiters.clear();
}

registerProjectClosingHook(() => {
  resetCompositeSourcePresentations();
});
