import { AssetBrowser } from "../../features/userAssets";
import { useGenerationStore } from "../../features/generation";

/** Suppresses the singleton browser while the fullscreen generation dock owns it. */
export function AssetsSidebarView() {
  const comfyEditorOpen = useGenerationStore((state) => state.editorOpen);
  return comfyEditorOpen ? null : (
    <AssetBrowser previewPresentation="workspace" />
  );
}
