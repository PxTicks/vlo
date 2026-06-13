import { useEffect, useLayoutEffect } from "react";
import { registerPreSaveHook } from "../../core/persistence/preSaveHooks";
import type { Asset } from "../../types/Asset";
import {
  canRegenerateFromAssetMetadata,
  useGenerationStore,
} from "../../features/generation";
import { flushAllBrushMaskCommits } from "../../features/masks/api";
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
