import type { ExtensionDisposable } from "../types";
import {
  hostKeybindingRegistry,
  type HostKeybindingRegistry,
} from "./KeybindingRegistry";

/**
 * Chords owned by inline host handlers that predate the command table.
 * Reserving them makes the collision guarantee real for extension bindings
 * (colliding requests register inactive with a diagnostic) without rerouting
 * the handlers themselves. When one of these handlers migrates to a real
 * host command + `registerHostDefault`, delete its reservation here.
 *
 * Sources: TimelineContainer keydown (undo/redo global; copy/paste/delete in
 * the timeline region), useCanvasSelectionKeyboard (canvas delete),
 * AssetBrowser (library delete).
 */
const HOST_CHORD_RESERVATIONS: readonly {
  readonly id: string;
  readonly chord: string;
  readonly regions?: readonly string[];
}[] = [
  { id: "host.undo", chord: "Mod+Z" },
  { id: "host.redo", chord: "Mod+Shift+Z" },
  { id: "host.redo-y", chord: "Mod+Y" },
  { id: "host.timeline.copy", chord: "Mod+C", regions: ["timeline"] },
  { id: "host.timeline.paste", chord: "Mod+V", regions: ["timeline"] },
  {
    id: "host.delete",
    chord: "Delete",
    regions: ["timeline", "canvas", "assetBrowser"],
  },
  {
    id: "host.delete-backspace",
    chord: "Backspace",
    regions: ["timeline", "canvas", "assetBrowser"],
  },
];

export function installHostKeybindingReservations(
  registry: HostKeybindingRegistry = hostKeybindingRegistry,
): ExtensionDisposable {
  const registrations = HOST_CHORD_RESERVATIONS.map((reservation) =>
    registry.reserveHostChord(reservation),
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
