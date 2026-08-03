import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../types";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import { createExtensionAssetApi } from "../assets/createExtensionAssetApi";
import { createExtensionPlaybackApi } from "../playback/createExtensionPlaybackApi";
import { createExtensionSelectionApi } from "../selection/createExtensionSelectionApi";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useAssetStore } from "../../userAssets";
import { useProjectStore } from "../../project";
import { usePlayerStore } from "../../player";
import {
  playbackClock,
  playbackFrameClock,
} from "../../../core/playback/PlaybackClock";
import type { Asset } from "../../../types/Asset";

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): { scope: ExtensionApiScope; resources: ExtensionResource[] } {
  const resources: ExtensionResource[] = [];
  return {
    resources,
    scope: {
      extension: { id: extensionId, version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report,
    },
  };
}

describe("extension timeline reactivity", () => {
  it("signals committed model changes but not selection-only updates", () => {
    useTimelineStore.setState({ clips: [], tracks: [], selectedClipIds: [] });
    const { scope } = createScope("example.reactive");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const initial = api.getRevision();

    useTimelineStore.setState({ selectedClipIds: ["c1"] });
    expect(listener).not.toHaveBeenCalled();
    expect(api.getRevision()).toBe(initial);

    useTimelineStore.setState({ tracks: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    unsubscribe();

    useTimelineStore.setState({ clips: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates listener failures with an owner diagnostic and keeps notifying", () => {
    const report = vi.fn();
    const { scope } = createScope("example.reactive-boom", report);
    const api = createExtensionTimelineApi(scope);
    const unsubscribe = api.subscribe(() => {
      throw new Error("listener boom");
    });

    useTimelineStore.setState({ tracks: [] });
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Timeline subscriber failed"),
      expect.any(Error),
    );

    // Not unsubscribed by the failure: it reports again on the next commit.
    useTimelineStore.setState({ clips: [] });
    expect(report).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("enrolls subscriptions for owner-scope disposal", () => {
    const { scope, resources } = createScope("example.reactive-dispose");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    api.subscribe(listener);

    for (const resource of resources) {
      if (typeof resource === "function") void resource();
      else void resource.dispose();
    }
    useTimelineStore.setState({ tracks: [] });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("extension project-snapshot reactivity", () => {
  function setProjectConfig(
    patch: Partial<ReturnType<typeof useProjectStore.getState>["config"]>,
  ): void {
    const { config } = useProjectStore.getState();
    useProjectStore.setState({ config: { ...config, ...patch } });
  }

  it("signals changes to the values getProject() reports", () => {
    setProjectConfig({ aspectRatio: "16:9", fps: 30, fitMode: "cover" });
    const { scope } = createScope("example.project-reactive");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const initial = api.getRevision();

    setProjectConfig({ fps: 60 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    expect(api.getProject().fps).toBe(60);

    setProjectConfig({ fitMode: "contain" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(api.getProject().fitMode).toBe("contain");

    const wideRevision = api.getRevision();
    setProjectConfig({ aspectRatio: "9:16" });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(api.getRevision()).toBe(wideRevision + 1);
    // The snapshot's dimensions are derived from the aspect ratio, so this is
    // the change that would silently stale a cached project size.
    expect(api.getProject().width).toBeLessThan(api.getProject().height);

    unsubscribe();
    setProjectConfig({ fps: 24 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("stays quiet for project config the snapshot does not expose", () => {
    setProjectConfig({ layoutMode: "compact", assetBrowserDisplay: "grouped" });
    const { scope } = createScope("example.project-quiet");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    api.subscribe(listener);
    const initial = api.getRevision();

    setProjectConfig({ layoutMode: "full-height" });
    setProjectConfig({ assetBrowserDisplay: "ungrouped" });

    expect(listener).not.toHaveBeenCalled();
    expect(api.getRevision()).toBe(initial);
  });
});

describe("extension timeline tracks", () => {
  it("projects tracks in order with their host flags", () => {
    useTimelineStore.setState({
      clips: [],
      tracks: [
        {
          id: "track-1",
          type: "visual",
          label: "Video",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
        {
          id: "track-2",
          label: "Legacy",
          isVisible: false,
          isMuted: true,
          isLocked: true,
        },
      ],
    });
    const { scope } = createScope("example.tracks");
    const api = createExtensionTimelineApi(scope);

    expect(api.listTracks()).toEqual([
      {
        id: "track-1",
        index: 0,
        label: "Video",
        type: "visual",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
      {
        id: "track-2",
        index: 1,
        label: "Legacy",
        // A track with no recorded type reports null rather than guessing.
        type: null,
        isVisible: false,
        isMuted: true,
        isLocked: true,
      },
    ]);
  });

  it("returns a detached, frozen projection", () => {
    useTimelineStore.setState({
      tracks: [
        {
          id: "track-1",
          type: "visual",
          label: "Video",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        },
      ],
    });
    const { scope } = createScope("example.tracks-detached");
    const api = createExtensionTimelineApi(scope);
    const [track] = api.listTracks();

    expect(Object.isFrozen(track)).toBe(true);
    expect(() => {
      (track as { label: string }).label = "Mutated";
    }).toThrow(TypeError);
    expect(useTimelineStore.getState().tracks[0].label).toBe("Video");
  });
});

describe("extension selection", () => {
  it("reports the detached selection and signals only real changes", () => {
    useTimelineStore.setState({
      selectedClipIds: [],
      selectedTransitionId: null,
    });
    const { scope } = createScope("example.selection");
    const api = createExtensionSelectionApi(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const initial = api.getRevision();

    expect(api.get()).toEqual({ clipIds: [], transitionId: null });

    useTimelineStore.setState({ selectedClipIds: ["clip-a", "clip-b"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    expect(api.get()).toEqual({
      clipIds: ["clip-a", "clip-b"],
      transitionId: null,
    });

    // A fresh array holding the same selection is not a change.
    useTimelineStore.setState({ selectedClipIds: ["clip-a", "clip-b"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);

    // Order is part of the value: the snapshot reports host selection order.
    useTimelineStore.setState({ selectedClipIds: ["clip-b", "clip-a"] });
    expect(listener).toHaveBeenCalledTimes(2);

    useTimelineStore.setState({
      selectedClipIds: [],
      selectedTransitionId: "transition-1",
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(api.get()).toEqual({ clipIds: [], transitionId: "transition-1" });

    unsubscribe();
  });

  it("does not wake timeline subscribers", () => {
    useTimelineStore.setState({
      clips: [],
      selectedClipIds: [],
      selectedTransitionId: null,
    });
    const { scope } = createScope("example.selection-isolation");
    const timeline = createExtensionTimelineApi(scope);
    const timelineListener = vi.fn();
    timeline.subscribe(timelineListener);

    useTimelineStore.setState({ selectedClipIds: ["clip-a"] });

    expect(timelineListener).not.toHaveBeenCalled();
  });
});

describe("extension playback", () => {
  it("reads the playhead, the presented frame, and the transport", () => {
    playbackClock.setTime(4_800);
    playbackFrameClock.setTime(3_200);
    usePlayerStore.setState({ isPlaying: false });
    const { scope } = createScope("example.playback");
    const api = createExtensionPlaybackApi(scope);

    expect(api.getTime()).toBe(4_800);
    expect(api.getFrameTime()).toBe(3_200);
    expect(api.isPlaying()).toBe(false);

    usePlayerStore.setState({ isPlaying: true });
    expect(api.isPlaying()).toBe(true);
  });

  it("notifies on playhead moves and transport edges, once each", () => {
    playbackClock.setTime(0);
    usePlayerStore.setState({ isPlaying: false });
    const { scope } = createScope("example.playback-signal");
    const api = createExtensionPlaybackApi(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);

    playbackClock.setTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    // The clock suppresses no-op writes, so a repeated time stays silent.
    playbackClock.setTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    usePlayerStore.setState({ isPlaying: true });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    playbackClock.setTime(2_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("isolates listener failures with an owner diagnostic", () => {
    playbackClock.setTime(0);
    const report = vi.fn();
    const { scope } = createScope("example.playback-boom", report);
    const api = createExtensionPlaybackApi(scope);
    const unsubscribe = api.subscribe(() => {
      throw new Error("listener boom");
    });

    playbackClock.setTime(500);
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Playback subscriber failed"),
      expect.any(Error),
    );

    playbackClock.setTime(600);
    expect(report).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("extension asset reactivity", () => {
  it("signals library changes and exposes a matching revision", () => {
    useAssetStore.setState({ assets: [] });
    const { scope } = createScope("example.assets");
    const api = createExtensionAssetApi(scope);
    const listener = vi.fn();
    api.subscribe(listener);
    const initial = api.getRevision();

    const asset = {
      id: "asset-1",
      hash: "hash-1",
      name: "clip.mp4",
      type: "video",
      src: "clip.mp4",
    } as Asset;
    useAssetStore.setState({ assets: [asset] });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    expect(api.list().map((snapshot) => snapshot.id)).toEqual(["asset-1"]);
  });
});
