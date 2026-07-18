import { useEditorFocusStore } from "../../editorFocus/useEditorFocusStore";
import { usePlayerStore } from "../../player";
import { useProjectStore } from "../../project";
import { getTimelineStoreForTrustedHostAccess } from "../../timeline/api";
import type { ExtensionDisposable } from "../types";
import { hostContextKeys, type HostContextKeyService } from "./contextKeys";

/**
 * Publishes the timeline-derived context keys. Split out so tests exercising
 * command enablement can install it against seeded store state without the
 * project/focus publishers.
 *
 * - `selection.clipCount` — number of selected timeline clips.
 * - `selection.clipType` — the uniform type of the selected clips, or null
 *   when the selection is empty or mixed.
 * - `selection.transitionSelected` — a transition is selected.
 * - `timeline.canUndo` / `timeline.canRedo` — history availability.
 * - `timeline.canPaste` — pasting would succeed: clips are on the clipboard
 *   and at least one still has its source track (`pasteCopiedClipsAboveDraft`
 *   drops groups whose source track was deleted, so a bare clipboard check
 *   would enable a paste that is a guaranteed no-op).
 */
export function installTimelineContextKeys(
  contextKeys: HostContextKeyService = hostContextKeys,
): ExtensionDisposable {
  const timelineStore = getTimelineStoreForTrustedHostAccess();
  const publish = () => {
    const state = timelineStore.getState();
    contextKeys.set("selection.clipCount", state.selectedClipIds.length);
    const selectedTypes = new Set(
      state.clips
        .filter((clip) => state.selectedClipIds.includes(clip.id))
        .map((clip) => clip.type),
    );
    contextKeys.set(
      "selection.clipType",
      selectedTypes.size === 1 ? [...selectedTypes][0] : null,
    );
    contextKeys.set(
      "selection.transitionSelected",
      state.selectedTransitionId !== null,
    );
    contextKeys.set("timeline.canUndo", state.canUndo);
    contextKeys.set("timeline.canRedo", state.canRedo);
    contextKeys.set(
      "timeline.canPaste",
      state.copiedClips.some((clip) =>
        state.tracks.some((track) => track.id === clip.trackId),
      ),
    );
  };
  publish();
  const unsubscribe = timelineStore.subscribe(publish);
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  });
}

/**
 * Publishes the v1 host context-key set consumed by declarative `when`
 * clauses. Keys are documented SDK surface once shipped:
 *
 * - `project.open`   — a project (and its directory handle) is loaded.
 * - `editor.open`    — the editor shell is mounted. Today this equals
 *   `project.open` (the editor mounts exactly when a project loads); it is a
 *   separate key so the promise survives if that coupling ever changes.
 * - `focus.region`   — the editor focus region owning the keyboard, or null.
 * - `playback.playing` — the player transport is running.
 * - plus the timeline keys from {@link installTimelineContextKeys}.
 */
export function installHostContextKeyBindings(
  contextKeys: HostContextKeyService = hostContextKeys,
): ExtensionDisposable {
  const publishProject = () => {
    const state = useProjectStore.getState();
    const open = Boolean(state.project && state.rootHandle);
    contextKeys.set("project.open", open);
    contextKeys.set("editor.open", open);
  };
  const publishFocus = () => {
    contextKeys.set("focus.region", useEditorFocusStore.getState().region);
  };
  const publishPlayback = () => {
    contextKeys.set("playback.playing", usePlayerStore.getState().isPlaying);
  };

  publishProject();
  publishFocus();
  publishPlayback();
  const timelineKeys = installTimelineContextKeys(contextKeys);
  const unsubscribers = [
    useProjectStore.subscribe(publishProject),
    useEditorFocusStore.subscribe(publishFocus),
    usePlayerStore.subscribe(publishPlayback),
    () => void timelineKeys.dispose(),
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
