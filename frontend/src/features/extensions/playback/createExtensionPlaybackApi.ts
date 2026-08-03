import {
  playbackClock,
  playbackFrameClock,
} from "../../../core/playback/PlaybackClock";
import type { RevisionSource } from "../../../core/shell/revisionRelay";
import { usePlayerStore } from "../../player";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import type { ExtensionApiScope, ExtensionPlaybackApi } from "../types";

/**
 * Transport signal for the scoped playback read API.
 *
 * Deliberately *not* commit-grained, unlike the model relays: the playhead is
 * continuous, so during playback this fires once per rendered frame. It follows
 * `playbackClock` — the authoritative playhead, which the player advances from
 * the audio clock and which every seek/scrub path writes — plus the transport
 * store, which covers the play/pause edges where only the frame clock realigns.
 *
 * `playbackFrameClock` is deliberately not a second subscription: the player
 * sets it immediately before `playbackClock` in every path that moves the
 * playhead, so listening to both would double-notify on every frame for no
 * extra information.
 */
function createPlaybackSignal(): RevisionSource {
  let revision = 0;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;

  const notify = () => {
    revision += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolation with diagnostics belongs to the owner-scoped adapter.
      }
    }
  };

  return Object.freeze({
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (detach === null) {
        const unsubscribeClock = playbackClock.subscribe(notify);
        const unsubscribeTransport = usePlayerStore.subscribe(notify);
        detach = () => {
          unsubscribeClock();
          unsubscribeTransport();
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach !== null) {
          detach();
          detach = null;
        }
      };
    },
    getRevision: () => revision,
  });
}

const playbackSignal = createPlaybackSignal();

export function createExtensionPlaybackApi(
  scope: ExtensionApiScope,
): ExtensionPlaybackApi {
  return Object.freeze({
    getTime: () => playbackClock.time,
    // The presented frame comes from whichever clock the renderer is currently
    // reading — the same choice `Player` and `useTrackRenderEngine` make. Only
    // playback advances the frame clock; every seek and scrub path writes the
    // playhead alone, so returning the frame clock unconditionally would report
    // the frame from before the scrub while paused.
    getFrameTime: () =>
      usePlayerStore.getState().isPlaying
        ? playbackFrameClock.time
        : playbackClock.time,
    isPlaying: () => usePlayerStore.getState().isPlaying,
    subscribe: bindOwnerScopedSubscribe(scope, playbackSignal, "Playback"),
  });
}
