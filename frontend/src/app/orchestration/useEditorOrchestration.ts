import { useEffect } from "react";
import type { Asset } from "../../types/Asset";
import {
  canRegenerateFromAssetMetadata,
  useGenerationStore,
} from "../../features/generation";
import { registerAssetRegenerator } from "../../features/userAssets";

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
}
