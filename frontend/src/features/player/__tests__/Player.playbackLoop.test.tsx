// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

const {
  addLocalAssetMock,
  cancelExportMock,
  extractDialogProps,
  fileSystemServiceMock,
  mockDecoderWorkerPool,
  mockLiveFrameGraphConstructor,
  mockLiveFrameGraphState,
  mockPixiApp,
  playerControlsProps,
  mockViewport,
  playbackClockMock,
  playbackFrameClockMock,
  renderProjectFrameFileAtTickMock,
  runProjectExportMock,
  runSelectionExportMock,
} = vi.hoisted(() => {
    let playbackTime = 0;
    let playbackFrameTime = 0;
    const playbackSubscribers = new Set<(time: number) => void>();
    const playbackFrameSubscribers = new Set<(time: number) => void>();

    const playbackClock = {
      get time() {
        return playbackTime;
      },
      setTime: vi.fn((time: number) => {
        playbackTime = time;
        playbackSubscribers.forEach((subscriber) => subscriber(time));
      }),
      subscribe: vi.fn((subscriber: (time: number) => void) => {
        playbackSubscribers.add(subscriber);
        return () => playbackSubscribers.delete(subscriber);
      }),
    };

    const playbackFrameClock = {
      get time() {
        return playbackFrameTime;
      },
      setTime: vi.fn((time: number) => {
        playbackFrameTime = time;
        playbackFrameSubscribers.forEach((subscriber) => subscriber(time));
      }),
      subscribe: vi.fn((subscriber: (time: number) => void) => {
        playbackFrameSubscribers.add(subscriber);
        return () => playbackFrameSubscribers.delete(subscriber);
      }),
    };

    return {
      addLocalAssetMock: vi.fn(),
      cancelExportMock: vi.fn(),
      extractDialogProps: {
        current: null as null | Record<string, unknown>,
      },
      fileSystemServiceMock: {
        showSaveVideoPicker: vi.fn(),
      },
      mockDecoderWorkerPool: {
        warmUp: vi.fn(),
      },
      mockLiveFrameGraphConstructor: vi.fn(),
      mockLiveFrameGraphState: {
        enabled: true,
      },
      mockPixiApp: {
        renderer: {},
        render: vi.fn(),
        ticker: {
          start: vi.fn(),
          stop: vi.fn(),
        },
      },
      mockViewport: {
        moveCenter: vi.fn(),
        fit: vi.fn(),
      },
      playerControlsProps: {
        current: null as null | Record<string, unknown>,
      },
      playbackClockMock: playbackClock,
      playbackFrameClockMock: playbackFrameClock,
      renderProjectFrameFileAtTickMock: vi.fn(),
      runProjectExportMock: vi.fn(),
      runSelectionExportMock: vi.fn(),
    };
  });

vi.mock("../../timeline/useTimelineStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");

  interface TimelineStoreState {
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    selectedClipIds: string[];
  }

  const useTimelineStore = create<TimelineStoreState>(() => ({
    tracks: [],
    clips: [],
    selectedClipIds: [],
  }));

  return { useTimelineStore };
});

vi.mock("../usePlayerStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");

  interface PlayerStoreState {
    isPlaying: boolean;
    setIsPlaying: (isPlaying: boolean) => void;
    togglePlay: () => void;
  }

  const usePlayerStore = create<PlayerStoreState>((set) => ({
    isPlaying: false,
    setIsPlaying: (isPlaying) => set({ isPlaying }),
    togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  }));

  return { usePlayerStore };
});

vi.mock("../../project", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");

  interface ProjectStoreState {
    config: {
      fps: number;
      aspectRatio: string;
    };
    project?: {
      title: string;
    } | null;
  }

  const useProjectStore = create<ProjectStoreState>(() => ({
    config: {
      fps: 30,
      aspectRatio: "16:9",
    },
    project: { title: "My Project" },
  }));

  return { useProjectStore, fileSystemService: fileSystemServiceMock };
});

vi.mock("../../userAssets", () => ({
  addLocalAsset: addLocalAssetMock,
  useAssetStore: (selector: (state: { assets: never[] }) => unknown) =>
    selector({ assets: [] }),
}));

vi.mock("../../../core/extract/useExtractStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");

  interface ExtractStoreState {
    dialogOpen: boolean;
    dialogView: string;
    progress: number;
    frameSelectionMode: boolean;
    isProcessing: boolean;
    openDialog: () => void;
    closeDialog: () => void;
    setDialogView: (view: string) => void;
    setIsProcessing: (isProcessing: boolean) => void;
    setProgress: (progress: number) => void;
    exitFrameSelectionMode: () => void;
    enterFrameSelectionMode: () => void;
    onConfirmSelection: (() => Promise<void> | void) | null;
    setOnConfirmSelection: (
      handler: (() => Promise<void> | void) | null,
    ) => void;
  }

  const useExtractStore = create<ExtractStoreState>((set) => ({
    dialogOpen: false,
    dialogView: "closed",
    progress: 0,
    frameSelectionMode: false,
    isProcessing: false,
    onConfirmSelection: null,
    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => set({ dialogOpen: false }),
    setDialogView: (dialogView) => set({ dialogView }),
    setIsProcessing: (isProcessing) => set({ isProcessing }),
    setProgress: (progress) => set({ progress }),
    exitFrameSelectionMode: () => set({ frameSelectionMode: false }),
    enterFrameSelectionMode: () => set({ frameSelectionMode: true }),
    setOnConfirmSelection: (onConfirmSelection) => set({ onConfirmSelection }),
  }));

  return { useExtractStore };
});

vi.mock("../../timelineSelection", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");

  interface TimelineSelectionStoreState {
    selectionMode: boolean;
    selectionStartTick: number;
    selectionEndTick: number;
    selectionFpsOverride?: number | null;
    selectionFrameStep: number;
    enterSelectionMode: (start: number, end: number) => void;
    exitSelectionMode: () => void;
  }

  const useTimelineSelectionStore = create<TimelineSelectionStoreState>((set) => ({
    selectionMode: false,
    selectionStartTick: 0,
    selectionEndTick: 0,
    selectionFpsOverride: null,
    selectionFrameStep: 1,
    enterSelectionMode: (selectionStartTick, selectionEndTick) =>
      set({
        selectionMode: true,
        selectionStartTick,
        selectionEndTick,
      }),
    exitSelectionMode: () =>
      set({
        selectionMode: false,
        selectionStartTick: 0,
        selectionEndTick: 0,
      }),
  }));

  return {
    useTimelineSelectionStore,
    createPointTimelineSelection: (tick: number) => ({
      selectionStartTick: tick,
      selectionEndTick: tick,
    }),
    getDefaultSelectionEnd: (startTick: number) => startTick + TICKS_PER_SECOND,
    getClipsInSelection: (clips: TimelineClip[]) => clips,
  };
});

vi.mock("../services/AudioSystem", () => ({
  audioSystem: {
    notifyPlay: vi.fn(),
    resume: vi.fn(),
    getCurrentPlaybackTicks: vi.fn(() => playbackClockMock.time),
  },
}));

vi.mock("../../../core/playback/PlaybackClock", () => ({
  playbackClock: playbackClockMock,
  playbackFrameClock: playbackFrameClockMock,
  alignPlaybackTickToFrame: (time: number) => time,
}));

vi.mock("../components/TrackLayer", () => ({
  TrackLayer: () => null,
}));

vi.mock("../components/PlayerControls", () => ({
  PlayerControls: (props: Record<string, unknown>) => {
    playerControlsProps.current = props;
    return null;
  },
}));

vi.mock("../components/ExtractDialog", () => ({
  ExtractDialog: (props: Record<string, unknown>) => {
    extractDialogProps.current = props;
    return null;
  },
}));

vi.mock("../hooks/usePixiApp", () => ({
  usePixiApp: () => ({
    pixiApp: mockPixiApp,
    canvasSize: { width: 800, height: 600 },
  }),
}));

vi.mock("../../renderer", () => ({
  AudioTrackLayer: () => null,
  LiveFrameGraphCoordinator: class {
    constructor() {
      mockLiveFrameGraphConstructor();
    }

    participantCount = 0;
    dispose = vi.fn();
    renderFrame = vi.fn(async () => null);
    requestFrame = vi.fn();
    subscribeFrameRequests = vi.fn(() => () => {});
  },
  isLiveFrameGraphEnabled: () => mockLiveFrameGraphState.enabled,
  createCompositeSourcePolicySnapshot: (options: unknown) => options,
  startFramePlanningDiagnosticsConsole: () => () => {},
  getSharedDecoderWorkerPool: () => mockDecoderWorkerPool,
  useViewport: () => mockViewport,
  useExportJobController: () => ({
    cancel: cancelExportMock,
    runSelectionExport: runSelectionExportMock,
    runProjectExport: runProjectExportMock,
  }),
  renderProjectFrameFileAtTick: renderProjectFrameFileAtTickMock,
  getProjectDimensions: () => ({ width: 1920, height: 1080 }),
  mediaSecondsToTickExact: (seconds: number) => seconds * TICKS_PER_SECOND,
}));

import { Player } from "../Player";
import { useProjectStore } from "../../project";
import { fileSystemService } from "../../project";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { usePlayerStore } from "../usePlayerStore";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../timelineSelection";
import { audioSystem } from "../services/AudioSystem";
import { playbackClock, playbackFrameClock } from "../../../core/playback/PlaybackClock";
import { addLocalAsset } from "../../userAssets";

describe("Player playback loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveFrameGraphState.enabled = true;
    playerControlsProps.current = null;
    extractDialogProps.current = null;
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();
    renderProjectFrameFileAtTickMock.mockResolvedValue(
      new File(["frame"], "frame.webp", { type: "image/webp" }),
    );
    addLocalAssetMock.mockResolvedValue(null);
    runSelectionExportMock.mockResolvedValue(undefined);
    runProjectExportMock.mockResolvedValue(undefined);
    fileSystemServiceMock.showSaveVideoPicker.mockResolvedValue({
      name: "output.mp4",
    });

    const track: TimelineTrack = {
      id: "track-1",
      type: "visual",
      label: "Track 1",
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const clip: TimelineClip = {
      id: "clip-1",
      trackId: "track-1",
      assetId: "asset-1",
      name: "Clip 1",
      type: "video",
      start: 0,
      sourceDuration: 10 * TICKS_PER_SECOND,
      transformedDuration: 10 * TICKS_PER_SECOND,
      transformedOffset: 0,
      timelineDuration: 10 * TICKS_PER_SECOND,
      croppedSourceDuration: 10 * TICKS_PER_SECOND,
      offset: 0,
      transformations: [
        {
          id: "filter-1",
          type: "filter",
          isEnabled: true,
          parameters: { hue: 0 },
        },
      ],
    };

    act(() => {
      useProjectStore.setState({
        config: {
          fps: 30,
          aspectRatio: "16:9",
          fitMode: "cover",
          assetBrowserDisplay: "grouped",
        },
        project: {
          id: "project-1",
          title: "My Project",
          rootAssetsFolder: "assets",
          createdAt: 1,
          lastModified: 1,
        },
      });
      useTimelineStore.setState({
        tracks: [track],
        clips: [clip],
        selectedClipIds: [],
      });
      usePlayerStore.setState({ isPlaying: true });
      useExtractStore.setState({
        dialogOpen: false,
        dialogView: "choose",
        progress: 0,
        frameSelectionMode: false,
        isProcessing: false,
        onConfirmSelection: null,
      });
      useTimelineSelectionStore.setState({
        selectionMode: false,
        selectionStartTick: 0,
        selectionEndTick: 0,
        selectionFpsOverride: null,
        selectionFrameStep: 1,
      });
      playbackClock.setTime(2 * TICKS_PER_SECOND);
      playbackFrameClock.setTime(2 * TICKS_PER_SECOND);
    });
  });

  it("does not restart playback loop initialization when clip transforms update", async () => {
    render(<Player />);

    expect(mockDecoderWorkerPool.warmUp).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(audioSystem.notifyPlay).toHaveBeenCalledTimes(1);
    });
    expect(audioSystem.resume).toHaveBeenCalledTimes(1);

    act(() => {
      const currentClip = useTimelineStore.getState().clips[0];
      useTimelineStore.setState({
        clips: [
          {
            ...currentClip,
            transformations: [
              {
                id: "filter-1",
                type: "filter",
                isEnabled: true,
                parameters: { hue: 45 },
              },
            ],
          },
        ],
      });
    });

    expect(audioSystem.notifyPlay).toHaveBeenCalledTimes(1);
    expect(audioSystem.resume).toHaveBeenCalledTimes(1);
  });

  it("does not create the live frame graph coordinator when rollback is enabled", () => {
    mockLiveFrameGraphState.enabled = false;

    render(<Player />);

    expect(mockLiveFrameGraphConstructor).not.toHaveBeenCalled();
  });

  it("toggles play from paused and snaps the frame clock before resuming audio", () => {
    act(() => {
      usePlayerStore.setState({ isPlaying: false });
      playbackClock.setTime(1234);
    });
    render(<Player />);

    act(() => {
      (
        playerControlsProps.current?.onTogglePlay as () => void
      )();
    });

    expect(playbackFrameClock.setTime).toHaveBeenCalledWith(1234);
    expect(audioSystem.resume).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("pauses playback on the next frame boundary", () => {
    playbackClock.setTime(TICKS_PER_SECOND + 1);
    render(<Player />);

    act(() => {
      (
        playerControlsProps.current?.onTogglePlay as () => void
      )();
    });

    expect(playbackClock.setTime).toHaveBeenCalled();
    expect(playbackFrameClock.setTime).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("extracts a selected frame and imports it as an asset", async () => {
    render(<Player />);
    act(() => {
      (
        extractDialogProps.current?.onExtractFrame as () => void
      )();
    });
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(useExtractStore.getState().frameSelectionMode).toBe(true);

    await act(async () => {
      await useExtractStore.getState().onConfirmSelection?.();
    });

    expect(renderProjectFrameFileAtTickMock).toHaveBeenCalledWith(
      playbackClock.time,
      {
        filenamePrefix: "frame",
        mimeType: "image/webp",
        quality: 0.95,
      },
    );
    expect(addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        source: "extracted",
        timelineSelection: expect.any(Object),
      }),
    );
    expect(useExtractStore.getState().dialogOpen).toBe(false);
  });

  it("closes the frame dialog even when rendering fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderProjectFrameFileAtTickMock.mockRejectedValueOnce(
      new Error("renderer failed"),
    );
    render(<Player />);
    act(() => {
      (
        extractDialogProps.current?.onExtractFrame as () => void
      )();
    });
    await act(async () => {
      await useExtractStore.getState().onConfirmSelection?.();
    });
    expect(error).toHaveBeenCalledWith(
      "Frame extraction failed",
      expect.any(Error),
    );
    expect(useExtractStore.getState().dialogOpen).toBe(false);
    error.mockRestore();
  });

  it("enters a range selection and exports the confirmed range with progress", async () => {
    render(<Player />);
    act(() => {
      (
        extractDialogProps.current?.onExtractSelection as () => void
      )();
    });
    expect(useTimelineSelectionStore.getState().selectionMode).toBe(true);

    act(() => {
      useTimelineSelectionStore.setState({
        selectionStartTick: 10,
        selectionEndTick: 20,
        selectionFpsOverride: 12,
        selectionFrameStep: 2,
      });
    });
    await act(async () => {
      await useExtractStore.getState().onConfirmSelection?.();
    });
    expect(runSelectionExportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionStartTick: 10,
        selectionEndTick: 20,
        selectionFpsOverride: 12,
        selectionFrameStep: 2,
        onProgress: expect.any(Function),
      }),
    );
    const onProgress = runSelectionExportMock.mock.calls[0]?.[0].onProgress;
    act(() => onProgress(55));
    expect(useExtractStore.getState().progress).toBe(55);
  });

  it("cancels processing and closes the dialog", () => {
    act(() => {
      useExtractStore.setState({ dialogOpen: true });
    });
    render(<Player />);
    act(() => {
      (
        extractDialogProps.current?.onCancelProcessing as () => void
      )();
    });
    expect(cancelExportMock).toHaveBeenCalled();
    expect(useExtractStore.getState().dialogOpen).toBe(false);
  });

  it("exports a project using the titled save picker and reports progress", async () => {
    render(<Player />);
    await act(async () => {
      await (
        extractDialogProps.current?.onExport as (
          resolution: number,
        ) => Promise<void>
      )(1080);
    });
    expect(fileSystemService.showSaveVideoPicker).toHaveBeenCalledWith(
      "My Project.mp4",
    );
    expect(runProjectExportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: 1080,
        fileHandle: expect.any(Object),
        onProgress: expect.any(Function),
      }),
    );
    const onProgress = runProjectExportMock.mock.calls[0]?.[0].onProgress;
    act(() => onProgress(70));
    expect(useExtractStore.getState().progress).toBe(70);
    expect(useExtractStore.getState().dialogOpen).toBe(false);
  });

  it("uses the untitled picker and silently handles picker cancellation", async () => {
    act(() => {
      useProjectStore.setState({ project: null });
    });
    fileSystemServiceMock.showSaveVideoPicker.mockRejectedValueOnce(
      new DOMException("cancelled", "AbortError"),
    );
    render(<Player />);
    await act(async () => {
      await (
        extractDialogProps.current?.onExport as (
          resolution: number,
        ) => Promise<void>
      )(720);
    });
    expect(fileSystemService.showSaveVideoPicker).toHaveBeenCalledWith();
    expect(runProjectExportMock).not.toHaveBeenCalled();
  });

  it("reports non-cancellation picker failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fileSystemServiceMock.showSaveVideoPicker.mockRejectedValueOnce(
      new Error("picker unavailable"),
    );
    render(<Player />);
    await act(async () => {
      await (
        extractDialogProps.current?.onExport as (
          resolution: number,
        ) => Promise<void>
      )(720);
    });
    expect(error).toHaveBeenCalledWith(
      "Failed to open save file picker",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("fits the viewport and toggles fullscreen with error handling", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    render(<Player />);

    act(() => {
      (playerControlsProps.current?.onFitView as () => void)();
    });
    expect(mockViewport.moveCenter).toHaveBeenCalledWith(960, 540);
    expect(mockViewport.fit).toHaveBeenCalledWith(true);

    await act(async () => {
      await (
        playerControlsProps.current?.onToggleFullscreen as () => Promise<void>
      )();
    });
    expect(requestFullscreen).toHaveBeenCalled();

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: requestFullscreen.mock.instances[0],
    });
    await act(async () => {
      await (
        playerControlsProps.current?.onToggleFullscreen as () => Promise<void>
      )();
    });
    expect(exitFullscreen).toHaveBeenCalled();
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    Reflect.deleteProperty(document, "exitFullscreen");
  });
});
