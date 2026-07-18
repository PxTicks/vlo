import type { JsonValue } from "@vlo/extension-sdk";
import {
  hostCommandRegistry,
  type HostCommandDefinition,
  type HostCommandRegistry,
} from "../extensions/commands/CommandRegistry";
import {
  hostKeybindingRegistry,
  type HostKeybindingRegistry,
} from "../extensions/commands/KeybindingRegistry";
import type { ExtensionDisposable } from "../extensions/types";
import { useTimelineStore } from "./useTimelineStore";

function readClipIdSubject(subject: JsonValue | undefined): string | null {
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    return null;
  }
  const clipId = (subject as Record<string, JsonValue>).clipId;
  return typeof clipId === "string" && clipId.length > 0 ? clipId : null;
}

/**
 * Timeline commands in the host command table. Subjects are detached
 * `{ clipId }` records where present; selection-driven commands read the
 * store. Each command's `when` clause carries the "only handle when
 * applicable" semantics the old inline keydown handler expressed with
 * boolean returns, so keybinding dispatch does not preventDefault when the
 * command has nothing to act on.
 */
const timelineHostCommands: readonly HostCommandDefinition[] = [
  {
    id: "timeline.clip.delete",
    title: "Delete",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const clipId = readClipIdSubject(subject);
      if (!clipId) return;
      const store = useTimelineStore.getState();
      const ids =
        store.selectedClipIds.length > 0 ? store.selectedClipIds : [clipId];
      store.removeClips(ids);
      store.selectClip(null);
    },
  },
  {
    id: "timeline.clip.copy",
    title: "Copy",
    when: {
      and: [{ key: "project.open" }, { key: "selection.clipCount" }],
    },
    run: () => {
      useTimelineStore.getState().copySelectedClip();
    },
  },
  {
    id: "timeline.clip.paste",
    title: "Paste",
    // canPaste, not a bare clipboard check: paste is a guaranteed no-op when
    // every copied clip's source track is gone, and a no-op command must not
    // swallow the key event.
    when: { key: "timeline.canPaste" },
    run: () => {
      useTimelineStore.getState().pasteCopiedClipAbove();
    },
  },
  {
    id: "timeline.clip.toggle-mute",
    title: "Mute",
    when: { key: "project.open" },
    run: ({ subject }) => {
      const clipId = readClipIdSubject(subject);
      if (!clipId) return;
      useTimelineStore.getState().toggleClipMute(clipId);
    },
  },
  {
    id: "timeline.undo",
    title: "Undo",
    when: { key: "timeline.canUndo" },
    run: () => {
      useTimelineStore.getState().undo();
    },
  },
  {
    id: "timeline.redo",
    title: "Redo",
    when: { key: "timeline.canRedo" },
    run: () => {
      useTimelineStore.getState().redo();
    },
  },
  {
    id: "timeline.delete-selection",
    title: "Delete Selection",
    when: {
      or: [
        { key: "selection.transitionSelected" },
        { key: "selection.clipCount" },
      ],
    },
    run: () => {
      const store = useTimelineStore.getState();
      if (store.selectedTransitionId) {
        store.removeTransition(store.selectedTransitionId);
        store.selectTransition(null);
        return;
      }
      if (store.selectedClipIds.length === 0) return;
      store.removeClips(store.selectedClipIds);
      store.selectClip(null);
    },
  },
];

/**
 * The host chords these commands own. Registered as real `registerHostDefault`
 * bindings (not reservations): dispatch executes through the command table and
 * extension bindings colliding with them are shadowed at registration.
 */
const timelineHostKeybindings: readonly {
  readonly id: string;
  readonly chord: string;
  readonly commandId: string;
  readonly regions?: readonly string[];
}[] = [
  { id: "host.timeline.undo", chord: "Mod+Z", commandId: "timeline.undo" },
  {
    id: "host.timeline.redo",
    chord: "Mod+Shift+Z",
    commandId: "timeline.redo",
  },
  { id: "host.timeline.redo-y", chord: "Mod+Y", commandId: "timeline.redo" },
  {
    id: "host.timeline.copy",
    chord: "Mod+C",
    commandId: "timeline.clip.copy",
    regions: ["timeline"],
  },
  {
    id: "host.timeline.paste",
    chord: "Mod+V",
    commandId: "timeline.clip.paste",
    regions: ["timeline"],
  },
  {
    id: "host.timeline.delete",
    chord: "Delete",
    commandId: "timeline.delete-selection",
    regions: ["timeline"],
  },
  {
    id: "host.timeline.delete-backspace",
    chord: "Backspace",
    commandId: "timeline.delete-selection",
    regions: ["timeline"],
  },
];

export function installTimelineHostCommands(
  registry: HostCommandRegistry = hostCommandRegistry,
  keybindings: HostKeybindingRegistry = hostKeybindingRegistry,
): ExtensionDisposable {
  const registrations = [
    ...timelineHostCommands.map((definition) =>
      registry.registerHostCommand(definition),
    ),
    ...timelineHostKeybindings.map((binding) =>
      keybindings.registerHostDefault(binding),
    ),
  ];
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const registration of [...registrations].reverse()) {
        registration.dispose();
      }
    },
  });
}
