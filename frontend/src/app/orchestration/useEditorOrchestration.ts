import { useEffect, useLayoutEffect } from "react";
import { registerPreSaveHook } from "../../core/persistence/preSaveHooks";
import type { Asset } from "../../types/Asset";
import {
  canRegenerateFromAssetMetadata,
  useGenerationStore,
} from "../../features/generation";
import { flushAllBrushMaskCommits } from "../../features/masks/api";
import {
  selectIsLocalModelWorkHoldingGpu,
  useModelWorkStore,
} from "../../features/modelWork";
import { useProjectStore } from "../../features/project";
import {
  flushPendingTimelinePersistence,
  replaceTimelineSnapshot,
} from "../../features/timeline/api";
import { registerAssetRegenerator } from "../../features/userAssets";
import type { ProjectTimelineSnapshotRequest } from "../../features/project";

function applyTimelineSnapshotRequest(
  request: ProjectTimelineSnapshotRequest | null,
): void {
  if (!request) {
    return;
  }

  replaceTimelineSnapshot(request.snapshot);
  useProjectStore.getState().acknowledgeTimelineSnapshotRequest(request.id);
}

export function useEditorOrchestration(): void {
  useEffect(
    () =>
      registerAssetRegenerator({
        canRegenerate: (asset: Asset) =>
          canRegenerateFromAssetMetadata(asset.creationMetadata),
        regenerate: (asset: Asset) =>
          useGenerationStore
            .getState()
            .loadWorkflowFromAssetMetadata(asset),
      }),
    [],
  );

  useEffect(() => {
    const unregisterBrushMaskFlush = registerPreSaveHook(
      flushAllBrushMaskCommits,
    );
    const unregisterTimelineFlush = registerPreSaveHook(
      flushPendingTimelinePersistence,
    );

    return () => {
      unregisterTimelineFlush();
      unregisterBrushMaskFlush();
    };
  }, []);

  useEffect(() => {
    // The model-work ledger is operational state, not panel state: the
    // generation queue's admission gate reads it whether or not the Queue panel
    // is open, and a hidden panel must not take the socket down with it.
    const { connect, disconnect } = useModelWorkStore.getState();
    connect();

    // Resume the generation queue the moment vlo's own models hand the GPU
    // back. Owned here rather than inside the generation store so it is
    // disposed with the editor instead of outliving it.
    const unsubscribe = useModelWorkStore.subscribe((state, previous) => {
      if (
        selectIsLocalModelWorkHoldingGpu(previous) &&
        !selectIsLocalModelWorkHoldingGpu(state)
      ) {
        useGenerationStore.getState().resumeGenerationQueueAfterGpuRelease();
      }
    });

    return () => {
      unsubscribe();
      disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    applyTimelineSnapshotRequest(
      useProjectStore.getState().timelineSnapshotRequest,
    );

    return useProjectStore.subscribe((state, previousState) => {
      if (
        state.timelineSnapshotRequest !==
        previousState.timelineSnapshotRequest
      ) {
        applyTimelineSnapshotRequest(state.timelineSnapshotRequest);
      }
    });
  }, []);
}
