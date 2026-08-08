import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource, VloExtensionApi } from "../types";
import {
  activate,
  collectEditPoints,
  getNavigationStateForConformance,
  LAST_TICK_STORAGE_KEY,
  resetNavigationStateForConformance,
} from "../../../../../extension-fixtures/navigation/frontend/src/index";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { installHostTransportController } from "../../../core/playback/transportController";
import { notifyProjectSaved } from "../../../core/project/projectLifecycleHooks";
import { runPreSaveHooks } from "../../../core/persistence/preSaveHooks";
import { snapTickToFrameGrid } from "../../../core/time/frameGrid";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useProjectStore } from "../../project";
import { usePlayerStore } from "../../player";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { createExtensionCommandApi } from "../commands/CommandRegistry";
import { createExtensionPlaybackApi } from "../playback/createExtensionPlaybackApi";
import { createExtensionProjectApi } from "../project/createExtensionProjectApi";
import { createExtensionSelectionApi } from "../selection/createExtensionSelectionApi";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import type { JsonValue } from "../types";

const FPS = 30;
const TICKS_PER_SECOND = 96_000;

function videoClip(
  id: string,
  assetId: string,
  start: number,
  duration: number,
): TimelineClip {
  return {
    id,
    trackId: "track-visual",
    type: "video",
    name: id,
    assetId,
    src: `${assetId}.mp4`,
    sourceDuration: duration,
    start,
    timelineDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    transformations: [],
  } as unknown as TimelineClip;
}

const TRACKS: TimelineTrack[] = [
  {
    id: "track-visual",
    label: "Visual",
    type: "visual",
    isVisible: true,
    isLocked: false,
    isMuted: false,
  },
];

/**
 * Stands in for the mounted `Player`, which cannot be rendered in a unit test
 * (it boots Pixi). It runs the same clamp-and-snap the player installs, so the
 * fixture exercises the real seek contract rather than a passthrough.
 */
function installTestTransport(options: { available?: boolean } = {}) {
  return installHostTransportController({
    canControl: () => options.available !== false,
    play: () => usePlayerStore.setState({ isPlaying: true }),
    pause: () => usePlayerStore.setState({ isPlaying: false }),
    seek: (timeTicks) =>
      playbackClock.setTime(snapTickToFrameGrid(Math.max(0, timeTicks), FPS)),
  });
}

interface Harness {
  api: VloExtensionApi;
  scope: ExtensionApiScope;
  resources: ExtensionResource[];
  projectValues: Map<string, JsonValue>;
  /** Mirrors the real store, which goes null once its closing hook runs. */
  closeProjectStorage: () => void;
  dispose: () => Promise<void>;
}

function createHarness(): Harness {
  const contextKeys = new HostContextKeyService();
  const commandTable = new HostCommandTable(contextKeys);
  const keybindings = new HostKeybindingRegistry(() => false);
  contextKeys.set("project.open", true);
  contextKeys.set("selection.clipCount", 1);

  const resources: ExtensionResource[] = [];
  const scope: ExtensionApiScope = {
    extension: { id: "example.navigation", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };

  const projectValues = new Map<string, JsonValue>();
  const projectStore = {
    get: async (key: string) => projectValues.get(key),
    set: async (key: string, value: JsonValue) => {
      projectValues.set(key, structuredClone(value));
    },
    delete: async (key: string) => void projectValues.delete(key),
    keys: async () => [...projectValues.keys()],
    subscribe: () => () => undefined,
    getRevision: () => projectValues.size,
  };

  let projectStorageClosed = false;
  const api = {
    timeline: createExtensionTimelineApi(scope),
    playback: createExtensionPlaybackApi(scope),
    selection: createExtensionSelectionApi(scope),
    project: createExtensionProjectApi(scope),
    storage: {
      local: projectStore,
      get project() {
        return projectStorageClosed ? null : projectStore;
      },
    },
    ui: {
      commands: createExtensionCommandApi(
        scope,
        commandTable,
        keybindings,
        contextKeys,
      ),
    },
  } as unknown as VloExtensionApi;

  return {
    api,
    scope,
    resources,
    projectValues,
    closeProjectStorage: () => {
      projectStorageClosed = true;
    },
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
  };
}

function activateFixture(harness: Harness) {
  const disposers: ExtensionResource[] = [];
  activate({
    extension: { id: "example.navigation", version: "1.0.0" },
    sdkVersion: "1.10.0",
    signal: harness.scope.signal,
    api: harness.api,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    onDispose: (resource) => disposers.push(resource),
    exportApi: vi.fn(),
  });
  return disposers;
}

function seedTimeline() {
  useTimelineStore.setState({
    tracks: TRACKS,
    clips: [
      videoClip("clip-a", "asset-1", 0, TICKS_PER_SECOND),
      videoClip("clip-b", "asset-2", TICKS_PER_SECOND, TICKS_PER_SECOND),
      videoClip("clip-c", "asset-1", 2 * TICKS_PER_SECOND, TICKS_PER_SECOND),
    ],
    transitions: [],
    selectedClipIds: [],
    selectedTransitionId: null,
  });
}

describe("navigation conformance fixture", () => {
  afterEach(() => {
    resetNavigationStateForConformance();
    useProjectStore.setState({ project: null, rootHandle: null });
  });

  it("derives edit points from placed clips only", () => {
    expect(
      collectEditPoints([
        {
          id: "clip-a",
          type: "video",
          name: "a",
          trackId: "t",
          startTicks: 0,
          durationTicks: 100,
          sourceOffsetTicks: 0,
          sourceDurationTicks: 100,
          croppedSourceDurationTicks: 100,
          isMuted: false,
          rangeMasks: [],
          transformations: [],
        },
        {
          id: "clip-a::mask::m1",
          type: "mask",
          name: "mask",
          trackId: "t",
          startTicks: 40,
          durationTicks: 20,
          sourceOffsetTicks: 0,
          sourceDurationTicks: 20,
          croppedSourceDurationTicks: 20,
          isMuted: false,
          rangeMasks: [],
          transformations: [],
        },
      ]),
    ).toEqual([0, 100]);
  });

  it("navigates the transport through the host player and reports refusals", async () => {
    seedTimeline();
    useProjectStore.setState({ config: { ...useProjectStore.getState().config, fps: FPS } });
    playbackClock.setTime(0);
    const harness = createHarness();
    const disposers = activateFixture(harness);
    const uninstall = installTestTransport();

    expect(await harness.api.ui.commands.execute("next-edit")).toBe(true);
    expect(playbackClock.time).toBe(TICKS_PER_SECOND);
    expect(getNavigationStateForConformance().lastSeek).toEqual({
      ok: true,
      changed: true,
    });

    expect(await harness.api.ui.commands.execute("previous-edit")).toBe(true);
    expect(playbackClock.time).toBe(0);

    // Past the last edit point there is nowhere to go, so no seek is issued.
    playbackClock.setTime(4 * TICKS_PER_SECOND);
    resetNavigationStateForConformance();
    await harness.api.ui.commands.execute("next-edit");
    expect(getNavigationStateForConformance().lastSeek).toBeNull();

    uninstall();
    const uninstallBusy = installTestTransport({ available: false });
    playbackClock.setTime(0);
    await harness.api.ui.commands.execute("next-edit");
    expect(getNavigationStateForConformance().lastSeek).toEqual({
      ok: false,
      code: "transport_busy",
      message: expect.any(String),
    });
    expect(playbackClock.time).toBe(0);

    uninstallBusy();
    await harness.api.ui.commands.execute("next-edit");
    expect(getNavigationStateForConformance().lastSeek).toMatchObject({
      ok: false,
      code: "no_transport",
    });

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("turns one selected clip into every clip using the same asset", async () => {
    seedTimeline();
    useTimelineStore.setState({ selectedClipIds: ["clip-a"] });
    const harness = createHarness();
    const disposers = activateFixture(harness);

    expect(await harness.api.ui.commands.execute("select-asset-siblings")).toBe(
      true,
    );

    expect(useTimelineStore.getState().selectedClipIds).toEqual([
      "clip-a",
      "clip-c",
    ]);
    expect(getNavigationStateForConformance().lastSelection).toEqual({
      ok: true,
      changed: true,
    });

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });

  it("tracks project identity and flushes state before the host saves", async () => {
    seedTimeline();
    playbackClock.setTime(12_345);
    useProjectStore.setState({
      project: {
        id: "project-1",
        title: "Fixture project",
        rootAssetsFolder: "assets",
        createdAt: 10,
        lastModified: 20,
      },
      rootHandle: {} as FileSystemDirectoryHandle,
    });

    const harness = createHarness();
    const disposers = activateFixture(harness);
    expect(getNavigationStateForConformance().projectId).toBe("project-1");

    // The host runs pre-save hooks while project storage is still open — on a
    // project switch that ordering is the whole point, and it is pinned
    // against the real store in features/project/__tests__/useProjectStore.
    await runPreSaveHooks();
    expect(harness.projectValues.get(LAST_TICK_STORAGE_KEY)).toBe(12_345);
    expect(getNavigationStateForConformance().savedTick).toBe(12_345);

    // Once storage has gone, the same hook is a no-op rather than a failure:
    // `storage.project` is null between projects, and an extension must not
    // break a save by assuming otherwise.
    harness.projectValues.clear();
    harness.closeProjectStorage();
    await expect(runPreSaveHooks()).resolves.toBeGreaterThan(0);
    expect(harness.projectValues.size).toBe(0);

    // A save moves the snapshot without any store change, so the fixture's own
    // subscription sees it.
    notifyProjectSaved("project-1");
    expect(harness.api.project.get()?.lastSavedAt).toEqual(expect.any(Number));

    useProjectStore.setState({ project: null, rootHandle: null });
    expect(getNavigationStateForConformance().projectId).toBeNull();

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();

    // Disposal removes the pre-save hook: a later save writes nothing.
    harness.projectValues.clear();
    await runPreSaveHooks();
    expect(harness.projectValues.size).toBe(0);
  });
});
