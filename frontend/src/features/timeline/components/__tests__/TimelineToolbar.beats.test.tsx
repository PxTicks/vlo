import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TimelineToolbar } from "../TimelineToolbar";
import { useTimelineStore } from "../../useTimelineStore";
import type {
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { MarkersComponent } from "../../../../types/Components";

const beatApiMocks = vi.hoisted(() => ({
  registerBeatThisSource: vi.fn(),
  detectBeats: vi.fn(),
}));

const assetMocks = vi.hoisted(() => ({
  ensureAssetSourceLoaded: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
  extractPrimaryAudioTrack: vi.fn(),
}));

vi.mock("../../services/beatThisApi", () => ({
  registerBeatThisSource: beatApiMocks.registerBeatThisSource,
  detectBeats: beatApiMocks.detectBeats,
}));

vi.mock("../../../userAssets/publicApi", () => ({
  ensureAssetSourceLoaded: assetMocks.ensureAssetSourceLoaded,
}));

vi.mock("../../../userAssets/services/MediaProcessingService", () => ({
  mediaProcessingService: {
    extractPrimaryAudioTrack: mediaMocks.extractPrimaryAudioTrack,
  },
}));

const audioClip: StandardTimelineClip = {
  id: "clip_1",
  trackId: "track_1",
  start: 0,
  timelineDuration: 96_000,
  type: "audio",
  name: "Test Audio",
  assetId: "asset-1",
  transformations: [],
  offset: 0,
  sourceDuration: 96_000,
  transformedDuration: 96_000,
  transformedOffset: 0,
  croppedSourceDuration: 96_000,
};

const track: TimelineTrack = {
  id: "track_1",
  type: "audio",
  label: "Audio",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

function seedStoreWithSelection(clip: StandardTimelineClip) {
  useTimelineStore.setState({
    clips: [clip],
    tracks: [track],
    selectedClipIds: [clip.id],
  });
}

describe("TimelineToolbar beat detection", () => {
  beforeEach(() => {
    beatApiMocks.registerBeatThisSource.mockReset();
    beatApiMocks.detectBeats.mockReset();
    assetMocks.ensureAssetSourceLoaded.mockReset();
    mediaMocks.extractPrimaryAudioTrack.mockReset();

    assetMocks.ensureAssetSourceLoaded.mockResolvedValue({
      id: "asset-1",
      hash: "hash-1",
      type: "audio",
      file: new File([new Uint8Array([1, 2, 3])], "audio.wav", {
        type: "audio/wav",
      }),
    });

    beatApiMocks.registerBeatThisSource.mockResolvedValue({
      sourceId: "hash-1",
    });
    beatApiMocks.detectBeats.mockResolvedValue({
      sourceId: "hash-1",
      modelName: "final0",
      dbn: false,
      beats: [
        { timeSeconds: 0.5, timeTicks: 48_000, isDownbeat: true },
        { timeSeconds: 1.0, timeTicks: 96_000, isDownbeat: false },
      ],
      beatCount: 2,
      downbeatCount: 1,
    });

    seedStoreWithSelection(audioClip);
  });

  it("writes detected beats as kind-tagged markers on the selected clip", async () => {
    render(<TimelineToolbar />);

    fireEvent.click(screen.getByTestId("timeline-detect-beats"));

    await waitFor(() => {
      expect(beatApiMocks.detectBeats).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "hash-1" }),
      );
    });

    await waitFor(() => {
      const updatedClip = useTimelineStore
        .getState()
        .clips.find((c) => c.id === audioClip.id) as StandardTimelineClip;
      const markers = (updatedClip.components ?? []).find(
        (component): component is MarkersComponent =>
          component.type === "markers",
      );
      expect(markers?.parameters.markers).toHaveLength(2);
      expect(markers?.parameters.markers.map((m) => m.kind)).toEqual([
        "downbeat",
        "beat",
      ]);
      expect(markers?.parameters.markers.map((m) => m.sourceTimeTicks)).toEqual(
        [48_000, 96_000],
      );
    });
  });

  it("disables the button when the selected clip already has beat markers", () => {
    const existingMarkers: MarkersComponent = {
      id: "markers-1",
      type: "markers",
      parameters: {
        markers: [
          {
            id: "m1",
            sourceTimeTicks: 1000,
            kind: "beat",
          },
        ],
      },
    };
    useTimelineStore.setState({
      clips: [{ ...audioClip, components: [existingMarkers] }],
      tracks: [track],
      selectedClipIds: [audioClip.id],
    });

    render(<TimelineToolbar />);

    expect(screen.getByTestId("timeline-detect-beats")).toBeDisabled();
    expect(beatApiMocks.detectBeats).not.toHaveBeenCalled();
  });

  it("blocks regeneration with an alert when a non-selected target already has beats", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    const existingMarkers: MarkersComponent = {
      id: "markers-1",
      type: "markers",
      parameters: {
        markers: [{ id: "m1", sourceTimeTicks: 0, kind: "downbeat" }],
      },
    };
    useTimelineStore.setState({
      clips: [{ ...audioClip, components: [existingMarkers] }],
      tracks: [track],
      // No selection → handler falls back to playhead-intersecting clips. The
      // disabled-state guard only covers the selection path; the click-time
      // guard must catch this case too.
      selectedClipIds: [],
    });

    render(<TimelineToolbar />);
    fireEvent.click(screen.getByTestId("timeline-detect-beats"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        "Please remove all beats before regenerating.",
      );
    });
    expect(beatApiMocks.detectBeats).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("extracts audio from a video clip before sending it to the beat detector", async () => {
    const videoFile = new File([new Uint8Array([4, 5, 6])], "video.mp4", {
      type: "video/mp4",
    });
    assetMocks.ensureAssetSourceLoaded.mockResolvedValue({
      id: "asset-1",
      hash: "hash-1",
      type: "video",
      file: videoFile,
    });
    const extractedAudio = new File([new Uint8Array([9])], "video-audio.m4a", {
      type: "audio/mp4",
    });
    mediaMocks.extractPrimaryAudioTrack.mockResolvedValue(extractedAudio);

    seedStoreWithSelection({ ...audioClip, type: "video" });

    render(<TimelineToolbar />);
    fireEvent.click(screen.getByTestId("timeline-detect-beats"));

    await waitFor(() => {
      expect(mediaMocks.extractPrimaryAudioTrack).toHaveBeenCalledWith(
        videoFile,
      );
      expect(beatApiMocks.registerBeatThisSource).toHaveBeenCalledWith(
        extractedAudio,
        "hash-1",
      );
    });
  });
});
