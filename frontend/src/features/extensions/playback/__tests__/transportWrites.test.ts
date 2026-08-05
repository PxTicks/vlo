import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { createExtensionPlaybackApi } from "../createExtensionPlaybackApi";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import {
  installHostTransportController,
  type HostTransportController,
} from "../../../../core/playback/transportController";
import { usePlayerStore } from "../../../player";

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.transport", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function installController(
  overrides: Partial<HostTransportController> = {},
): () => void {
  return installHostTransportController({
    canControl: () => true,
    play: () => usePlayerStore.setState({ isPlaying: true }),
    pause: () => usePlayerStore.setState({ isPlaying: false }),
    seek: (timeTicks) => playbackClock.setTime(timeTicks),
    ...overrides,
  });
}

describe("extension transport writes", () => {
  afterEach(() => {
    usePlayerStore.setState({ isPlaying: false });
    playbackClock.setTime(0);
  });

  it("refuses every write when no player is mounted", () => {
    const api = createExtensionPlaybackApi(createScope());
    for (const result of [api.seek(1_000), api.play(), api.pause()]) {
      expect(result).toMatchObject({ ok: false, code: "no_transport" });
    }
    expect(playbackClock.time).toBe(0);
  });

  it("refuses while another flow owns the transport", () => {
    const seek = vi.fn();
    const uninstall = installController({ canControl: () => false, seek });
    const api = createExtensionPlaybackApi(createScope());

    expect(api.seek(1_000)).toMatchObject({
      ok: false,
      code: "transport_busy",
    });
    expect(seek).not.toHaveBeenCalled();
    uninstall();
  });

  it("reports what the player did, not what was asked for", () => {
    // A player that snaps to whole seconds: the extension asks for 1_500 and
    // the transport lands on 96_000, which is exactly why `changed` is
    // measured rather than assumed.
    const uninstall = installController({
      seek: (timeTicks) =>
        playbackClock.setTime(Math.round(timeTicks / 96_000) * 96_000),
    });
    const api = createExtensionPlaybackApi(createScope());

    expect(api.seek(50_000)).toEqual({ ok: true, changed: true });
    expect(playbackClock.time).toBe(96_000);

    // A second seek inside the same frame moves nothing.
    expect(api.seek(60_000)).toEqual({ ok: true, changed: false });

    expect(api.play()).toEqual({ ok: true, changed: true });
    expect(api.play()).toEqual({ ok: true, changed: false });
    expect(api.pause()).toEqual({ ok: true, changed: true });
    uninstall();
  });

  it("throws for a non-finite tick rather than reporting a refusal", () => {
    const uninstall = installController();
    const api = createExtensionPlaybackApi(createScope());

    expect(() => api.seek(Number.NaN)).toThrow(TypeError);
    expect(() => api.seek(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => api.seek("0" as unknown as number)).toThrow(TypeError);
    uninstall();
  });
});
