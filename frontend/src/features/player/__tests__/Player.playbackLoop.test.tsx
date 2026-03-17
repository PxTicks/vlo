// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../timeline";

const { mockPixiApp, mockViewport, playbackClockMock, playbackFrameClockMock } =
  vi.hoisted(() => {
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
      playbackClockMock: playbackClock,
      playbackFrameClockMock: playbackFrameClock,
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
  }

  const useProjectStore = create<ProjectStoreState>(() => ({
    config: {
      fps: 30,
      aspectRatio: "16:9",
    },
  }));

  return { useProjectStore };
});

vi.mock("../../userAssets", () => ({
  addLocalAsset: vi.fn(async () => undefined),
}));

vi.mock("../useExtractStore", async () => {
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
    setOnConfirmSelection: (_handler: unknown) => void;
  }

  const useExtractStore = create<ExtractStoreState>((set) => ({
    dialogOpen: false,
    dialogView: "closed",
    progress: 0,
    frameSelectionMode: false,
    isProcessing: false,
    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => set({ dialogOpen: false }),
    setDialogView: (dialogView) => set({ dialogView }),
    setIsProcessing: (isProcessing) => set({ isProcessing }),
    setProgress: (progress) => set({ progress }),
    exitFrameSelectionMode: () => set({ frameSelectionMode: false }),
    enterFrameSelectionMode: () => set({ frameSelectionMode: true }),
    setOnConfirmSelection: () => undefined,
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

vi.mock("../services/PlaybackClock", () => ({
  playbackClock: playbackClockMock,
  playbackFrameClock: playbackFrameClockMock,
  alignPlaybackTickToFrame: (time: number) => time,
}));

vi.mock("../components/TrackLayer", () => ({
  TrackLayer: () => null,
}));

vi.mock("../components/PlayerControls", () => ({
  PlayerControls: () => null,
}));

vi.mock("../components/ExtractDialog", () => ({
  ExtractDialog: () => null,
}));

vi.mock("../hooks/usePixiApp", () => ({
  usePixiApp: () => ({
    pixiApp: mockPixiApp,
    canvasSize: { width: 800, height: 600 },
  }),
}));

vi.mock("../../renderer", () => ({
  AudioTrackLayer: () => null,
  useViewport: () => mockViewport,
  useExportJobController: () => ({
    cancel: vi.fn(),
    runSelectionExport: vi.fn(),
    runProjectExport: vi.fn(),
  }),
  renderProjectFrameFileAtTick: vi.fn(),
  getProjectDimensions: () => ({ width: 1920, height: 1080 }),
}));

import { Player } from "../Player";
import { useProjectStore } from "../../project";
import { useTimelineStore } from "../../timeline";
import { usePlayerStore } from "../usePlayerStore";
import { audioSystem } from "../services/AudioSystem";
import { playbackClock, playbackFrameClock } from "../services/PlaybackClock";

describe("Player playback loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();

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
        },
      });
      useTimelineStore.setState({
        tracks: [track],
        clips: [clip],
        selectedClipIds: [],
      });
      usePlayerStore.setState({ isPlaying: true });
      playbackClock.setTime(2 * TICKS_PER_SECOND);
      playbackFrameClock.setTime(2 * TICKS_PER_SECOND);
    });
  });

  it("does not restart playback loop initialization when clip transforms update", async () => {
    render(<Player />);

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
});
