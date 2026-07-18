import type { JsonValue } from "@vlo/extension-sdk";
import {
  hostCommandRegistry,
  type HostCommandDefinition,
  type HostCommandRegistry,
} from "../extensions/commands/CommandRegistry";
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
 * Seed timeline clip commands. Subjects are detached `{ clipId }` records, and
 * behaviour matches the pre-command context-menu handlers: delete acts on the
 * whole selection when the subject clip is part of it.
 */
const timelineClipHostCommands: readonly HostCommandDefinition[] = [
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
    when: { key: "project.open" },
    run: () => {
      useTimelineStore.getState().copySelectedClip();
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
];

export function installTimelineClipHostCommands(
  registry: HostCommandRegistry = hostCommandRegistry,
): ExtensionDisposable {
  const registrations = timelineClipHostCommands.map((definition) =>
    registry.registerHostCommand(definition),
  );
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
