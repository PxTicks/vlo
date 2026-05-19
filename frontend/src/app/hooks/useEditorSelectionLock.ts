import { useExtractStore } from "../../features/player/useExtractStore";
import { useTimelineSelectionStore } from "../../features/timelineSelection";

export function useEditorSelectionLock(): boolean {
  const selectionMode = useTimelineSelectionStore((state) => state.selectionMode);
  const frameSelectionMode = useExtractStore(
    (state) => state.frameSelectionMode,
  );

  return Boolean(selectionMode || frameSelectionMode);
}
