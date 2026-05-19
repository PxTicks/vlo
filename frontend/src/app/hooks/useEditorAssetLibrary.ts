import { useEffect } from "react";
import { useProjectStore } from "../../features/project";
import { useAssetStore } from "../../features/userAssets";

export function useEditorAssetLibrary() {
  const projectId = useProjectStore((state) => state.project?.id);
  const rootAssetsFolder = useProjectStore(
    (state) => state.project?.rootAssetsFolder,
  );
  const fetchAssets = useAssetStore((state) => state.fetchAssets);

  useEffect(() => {
    if (!projectId || !rootAssetsFolder) {
      return;
    }

    void fetchAssets().then(() => {
      void useAssetStore.getState().scanForNewAssets();
    });
  }, [fetchAssets, projectId, rootAssetsFolder]);
}
