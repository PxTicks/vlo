import { useEditorFocusStore } from "../../editorFocus/useEditorFocusStore";
import { useProjectStore } from "../../project";
import { getTimelineStoreForTrustedHostAccess } from "../../timeline/api";
import type { ExtensionDisposable } from "../types";
import { hostContextKeys, type HostContextKeyService } from "./contextKeys";

/**
 * Publishes the v1 host context-key set consumed by declarative `when`
 * clauses. Keys are documented SDK surface once shipped:
 *
 * - `project.open`   — a project (and its directory handle) is loaded.
 * - `focus.region`   — the editor focus region owning the keyboard, or null.
 * - `selection.clipCount` — number of selected timeline clips.
 */
export function installHostContextKeyBindings(
  contextKeys: HostContextKeyService = hostContextKeys,
): ExtensionDisposable {
  const timelineStore = getTimelineStoreForTrustedHostAccess();

  const publishProject = () => {
    const state = useProjectStore.getState();
    contextKeys.set(
      "project.open",
      Boolean(state.project && state.rootHandle),
    );
  };
  const publishFocus = () => {
    contextKeys.set("focus.region", useEditorFocusStore.getState().region);
  };
  const publishSelection = () => {
    contextKeys.set(
      "selection.clipCount",
      timelineStore.getState().selectedClipIds.length,
    );
  };

  publishProject();
  publishFocus();
  publishSelection();
  const unsubscribers = [
    useProjectStore.subscribe(publishProject),
    useEditorFocusStore.subscribe(publishFocus),
    timelineStore.subscribe(publishSelection),
  ];

  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  });
}
