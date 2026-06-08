import { useEffect } from "react";
import { useProjectStore } from "../../features/project";
import { useCompositeLibraryStore } from "../../features/composite";
import { useAssetStore } from "../../features/userAssets";

export function useEditorAssetLibrary() {
  const projectId = useProjectStore((state) => state.project?.id);
  const rootAssetsFolder = useProjectStore(
    (state) => state.project?.rootAssetsFolder,
  );
  const fetchAssets = useAssetStore((state) => state.fetchAssets);
  const fetchComposites = useCompositeLibraryStore(
    (state) => state.fetchComposites,
  );

  useEffect(() => {
    if (!projectId || !rootAssetsFolder) {
      return;
    }

    void (async () => {
      try {
        await fetchComposites();
        await fetchAssets();
      } catch (error) {
        // Skip the disk scan if we couldn't load the asset index — scanning against
        // an empty/stale store would re-ingest existing files under new IDs.
        console.error(
          "[AssetLibrary] Skipping disk scan because asset index load failed",
          error,
        );
        return;
      }
      void useAssetStore.getState().scanForNewAssets();
    })();
  }, [fetchAssets, fetchComposites, projectId, rootAssetsFolder]);
}
