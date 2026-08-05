import type {
  ExtensionModule,
  ExtensionSelectionResult,
  ExtensionTimelineClipSnapshot,
  ExtensionTransportResult,
} from "@vlo/extension-sdk";

/** Where the fixture parks the playhead it visited, inside the project. */
export const LAST_TICK_STORAGE_KEY = "last-playhead-tick";

interface NavigationState {
  lastSeek: ExtensionTransportResult | null;
  lastSelection: ExtensionSelectionResult | null;
  projectId: string | null;
  savedTick: number | null;
}

const navigationState: NavigationState = {
  lastSeek: null,
  lastSelection: null,
  projectId: null,
  savedTick: null,
};

/** Test-only accessor; not part of any host contract. */
export function getNavigationStateForConformance(): Readonly<NavigationState> {
  return navigationState;
}

export function resetNavigationStateForConformance(): void {
  navigationState.lastSeek = null;
  navigationState.lastSelection = null;
  navigationState.projectId = null;
  navigationState.savedTick = null;
}

/**
 * Every clip boundary, ascending and deduplicated. Mask clips are excluded:
 * they are attached to a parent clip rather than placed on the timeline, so
 * their edges are not places a user navigates to.
 */
export function collectEditPoints(
  clips: readonly ExtensionTimelineClipSnapshot[],
): readonly number[] {
  const points = new Set<number>();
  for (const clip of clips) {
    if (clip.type === "mask") continue;
    points.add(clip.startTicks);
    points.add(clip.startTicks + clip.durationTicks);
  }
  return [...points].sort((left, right) => left - right);
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { playback, project, selection, storage, timeline } = context.api;
  const { commands } = context.api.ui;

  const seekToEdit = (direction: "next" | "previous") => {
    const points = collectEditPoints(timeline.listClips());
    const time = playback.getTime();
    const target =
      direction === "next"
        ? points.find((point) => point > time)
        : [...points].reverse().find((point) => point < time);
    if (target === undefined) return;
    // The result is the editor's answer, not a promise the seek landed where
    // it was asked: the host clamps and frame-snaps, and refuses outright
    // while an export owns the transport.
    navigationState.lastSeek = playback.seek(target);
  };

  commands.register({
    id: "next-edit",
    apiVersion: 1,
    title: "Go to next edit",
    when: { key: "project.open" },
    run: () => seekToEdit("next"),
  });

  commands.register({
    id: "previous-edit",
    apiVersion: 1,
    title: "Go to previous edit",
    when: { key: "project.open" },
    run: () => seekToEdit("previous"),
  });

  commands.register({
    id: "select-asset-siblings",
    apiVersion: 1,
    title: "Select every clip using this asset",
    when: { key: "selection.clipCount" },
    run: () => {
      const clips = timeline.listClips();
      const [selectedId] = selection.get().clipIds;
      const assetId = clips.find((clip) => clip.id === selectedId)?.assetId;
      if (assetId === undefined) return;
      navigationState.lastSelection = selection.setClips(
        clips
          .filter((clip) => clip.assetId === assetId)
          .map((clip) => clip.id),
      );
    },
  });

  commands.registerKeybinding({
    id: "next-edit-key",
    apiVersion: 1,
    chord: "Mod+Alt+ArrowRight",
    command: "next-edit",
  });

  const readProject = () => {
    navigationState.projectId = project.get()?.id ?? null;
  };
  readProject();
  // One subscription covers open, close, rename, and save — including the
  // moment `storage.project` becomes available or goes away.
  context.onDispose(project.subscribe(readProject));

  // Flush the playhead into project storage before the host writes the
  // document, so the value travels with the project rather than the machine.
  context.onDispose(
    project.onBeforeSave(async () => {
      const projectStorage = storage.project;
      if (!projectStorage) return;
      const tick = playback.getTime();
      await projectStorage.set(LAST_TICK_STORAGE_KEY, tick);
      navigationState.savedTick = tick;
    }),
  );

  context.logger.info("navigation fixture activated", {
    projectId: navigationState.projectId,
  });
};
