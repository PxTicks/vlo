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
 * host command + `registerHostDefault`, delete its reservation here — the
 * timeline chords already migrated (`features/timeline/hostCommands.ts`).
 *
 * Sources: useCanvasSelectionKeyboard (canvas delete), AssetBrowser
 * (library delete), CompositeBrowser (composite delete, assetBrowser region).
 */
const HOST_CHORD_RESERVATIONS: readonly {
  readonly id: string;
  readonly chord: string;
  readonly regions?: readonly string[];
}[] = [
  {
    id: "host.delete",
    chord: "Delete",
    regions: ["canvas", "assetBrowser"],
  },
  {
    id: "host.delete-backspace",
    chord: "Backspace",
    regions: ["canvas", "assetBrowser"],
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
