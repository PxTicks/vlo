import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { TICKS_PER_SECOND } from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import type {
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { NotificationHostMount } from "../../../../core/shell/NotificationHostMount";
import { hostNotificationCenter } from "../../../../core/shell/notificationCenter";
import { SamAudioExtractDialog } from "../SamAudioExtractDialog";
import { useSamAudioExtractDialogStore } from "../../store/useSamAudioExtractDialogStore";

const samAudioDialogMocks = vi.hoisted(() => ({
  mockCancelSeparationJob: vi.fn(),
  mockExtractTimelineClipAudioAsset: vi.fn(),
  mockGetSamAudioHealth: vi.fn(),
  mockRevealAssetInBrowser: vi.fn(),
  mockRunSamAudioSeparation: vi.fn(),
}));

vi.mock("../../services/samAudioApi", () => ({
  cancelSeparationJob: samAudioDialogMocks.mockCancelSeparationJob,
  getSamAudioHealth: samAudioDialogMocks.mockGetSamAudioHealth,
}));

vi.mock("../../services/runSamAudioSeparation", () => ({
  isSamAudioAbortError: (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
  runSamAudioSeparation: samAudioDialogMocks.mockRunSamAudioSeparation,
}));

vi.mock("../../../timeline/utils/clipAudioExtraction", () => ({
  extractTimelineClipAudioAsset:
    samAudioDialogMocks.mockExtractTimelineClipAudioAsset,
}));

vi.mock("../../../userAssets/useAssetBrowserRevealStore", () => ({
  revealAssetInBrowser: samAudioDialogMocks.mockRevealAssetInBrowser,
}));

vi.mock("../SamAudioModelDownloadOverlay", () => ({
  SamAudioModelDownloadOverlay: () => (
    <div data-testid="sam-audio-download-overlay">Download SAM-Audio</div>
  ),
}));

const track: TimelineTrack = {
  id: "track-1",
  type: "visual",
  label: "Video",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const clip: TimelineClip = {
  id: "clip-1",
  trackId: track.id,
  start: TICKS_PER_SECOND,
  timelineDuration: TICKS_PER_SECOND * 4,
  type: "video",
  name: "Interview",
  assetId: "asset-1",
  transformations: [],
  offset: 0,
  sourceDuration: TICKS_PER_SECOND * 4,
  transformedDuration: TICKS_PER_SECOND * 4,
  transformedOffset: 0,
  croppedSourceDuration: TICKS_PER_SECOND * 4,
};

function seedTimeline() {
  useTimelineStore.setState({
    clips: [clip],
    tracks: [track],
    selectedClipIds: [],
  });
}

function openDialog() {
  useSamAudioExtractDialogStore.getState().openForClip(clip.id);
  // The success confirmation goes to the shell notification centre now, so the
  // host mount is rendered beside the dialog rather than asserted through a
  // store: the assertion should still be "the user can read it".
  render(
    <>
      <SamAudioExtractDialog />
      <NotificationHostMount />
    </>,
  );
}

async function openConfigureWithAvailableModel() {
  samAudioDialogMocks.mockGetSamAudioHealth.mockResolvedValue({
    runtime: { ready: true },
  });
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Extract Selection" }));
  await waitFor(() => {
    expect(samAudioDialogMocks.mockGetSamAudioHealth).toHaveBeenCalled();
  });
}

describe("SamAudioExtractDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedTimeline();
    for (const entry of hostNotificationCenter.list()) {
      hostNotificationCenter.dismiss(entry.id);
    }
    useSamAudioExtractDialogStore.getState().close();
    useTimelineSelectionStore.getState().exitSelectionMode();
    useExtractStore.getState().setOnConfirmSelection(null);
    samAudioDialogMocks.mockExtractTimelineClipAudioAsset.mockResolvedValue({
      id: "extracted-audio-1",
      hash: "hash-extracted-audio-1",
      type: "audio",
      name: "Interview audio.wav",
      src: "blob:extracted-audio-1",
      duration: 4,
      createdAt: 1,
    });
    samAudioDialogMocks.mockRunSamAudioSeparation.mockResolvedValue({
      jobId: "job-1",
      targetClipId: "target-clip",
      residualClipId: "residual-clip",
    });
    samAudioDialogMocks.mockCancelSeparationJob.mockResolvedValue({
      jobId: "job-1",
      status: "cancelled",
      progress: 0.5,
      error: null,
      sourceId: "source-1",
      startTicks: 0,
      durationTicks: TICKS_PER_SECOND,
    });
  });

  it("extracts all audio with the existing raw extraction path", async () => {
    openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Extract All" }));

    await waitFor(() => {
      expect(
        samAudioDialogMocks.mockExtractTimelineClipAudioAsset,
      ).toHaveBeenCalledWith(clip, track);
    });
    expect(samAudioDialogMocks.mockRevealAssetInBrowser).toHaveBeenCalledWith(
      "extracted-audio-1",
    );
    expect(
      await screen.findByText("Audio Extracted to Timeline and Asset Browser"),
    ).toBeInTheDocument();
    const timeline = useTimelineStore.getState();
    const sourceTrackIndex = timeline.tracks.findIndex(
      (candidate) => candidate.id === track.id,
    );
    const insertedClip = timeline.clips.find(
      (candidate) =>
        "assetId" in candidate && candidate.assetId === "extracted-audio-1",
    );
    const sourceClip = timeline.clips.find((candidate) => candidate.id === clip.id);
    expect(sourceClip).toEqual(expect.objectContaining({ isMuted: true }));
    expect(insertedClip).toEqual(
      expect.objectContaining({
        type: "audio",
        start: clip.start,
        trackId: timeline.tracks[sourceTrackIndex + 1]?.id,
      }),
    );
  });

  it("enables isolation for a text-only SAM-Audio prompt", async () => {
    await openConfigureWithAvailableModel();

    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "man speaking" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Isolate Sound" }));

    await waitFor(() => {
      expect(samAudioDialogMocks.mockRunSamAudioSeparation).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: clip.id,
          textPrompt: "man speaking",
          spanSelection: null,
        }),
      );
    });
  });

  it("shows the backend diagnostic when SAM-Audio cannot be imported", async () => {
    const diagnostic =
      "Failed to import SAM-Audio. Install the optional SAM-Audio requirements " +
      "with `python -m pip install -r backend/requirements-sam-audio.txt`. " +
      "Underlying error: No module named 'sam_audio'";
    samAudioDialogMocks.mockRunSamAudioSeparation.mockRejectedValueOnce(
      new Error(diagnostic),
    );
    await openConfigureWithAvailableModel();

    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "man speaking" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Isolate Sound" }));

    expect(await screen.findByText(diagnostic)).toBeInTheDocument();
    expect(screen.getByLabelText("Text prompt")).toHaveValue("man speaking");
  });

  it("shows validation when no text prompt or range is selected", async () => {
    await openConfigureWithAvailableModel();

    expect(
      screen.getByText("Add a text prompt, select a timeline range, or use both."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Isolate Sound" })).toBeDisabled();
  });

  it("uses the shared timeline selection callback for range-only prompts", async () => {
    await openConfigureWithAvailableModel();

    fireEvent.click(screen.getByRole("button", { name: "Select Range" }));
    expect(useTimelineSelectionStore.getState().selectionMode).toBe(true);
    expect(
      useTimelineSelectionStore.getState().selectionIncludeModeEnabled,
    ).toBe(false);

    act(() => {
      useTimelineSelectionStore.getState().updateSelectionStart(
        TICKS_PER_SECOND * 2,
      );
      useTimelineSelectionStore.getState().updateSelectionEnd(
        TICKS_PER_SECOND * 3,
      );
      useExtractStore.getState().onConfirmSelection?.();
    });

    await waitFor(() => {
      expect(screen.getByText("2.00s - 3.00s")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Isolate Sound" }));

    await waitFor(() => {
      expect(samAudioDialogMocks.mockRunSamAudioSeparation).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: clip.id,
          textPrompt: "",
          spanSelection: {
            startTick: TICKS_PER_SECOND * 2,
            endTick: TICKS_PER_SECOND * 3,
          },
        }),
      );
    });
  });

  it("shows the SAM-Audio model download UI when the runtime is unavailable", async () => {
    samAudioDialogMocks.mockGetSamAudioHealth.mockResolvedValue({
      runtime: { ready: false, error: "Model missing" },
    });
    openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Extract Selection" }));

    expect(
      await screen.findByTestId("sam-audio-download-overlay"),
    ).toBeInTheDocument();
    expect(screen.getByText("Model missing")).toBeInTheDocument();
    // Nothing in the prompt form can be used until a runtime exists, so the
    // download panel owns the dialog on its own.
    expect(screen.queryByLabelText("Text prompt")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select Range" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Isolate Sound" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Add a text prompt, select a timeline range, or use both."),
    ).not.toBeInTheDocument();
  });

  it("cancels the active SAM-Audio backend job during processing", async () => {
    samAudioDialogMocks.mockGetSamAudioHealth.mockResolvedValue({
      runtime: { ready: true },
    });
    samAudioDialogMocks.mockRunSamAudioSeparation.mockImplementation(
      ({ onJobStatus, signal }) =>
        new Promise((_resolve, reject) => {
          onJobStatus?.({
            jobId: "job-1",
            status: "running",
            progress: 0.35,
            message: "Running separation",
            error: null,
            sourceId: "source-1",
            startTicks: 0,
            durationTicks: TICKS_PER_SECOND,
          });
          signal?.addEventListener("abort", () => {
            const error = new Error("Cancelled");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Extract Selection" }));
    await waitFor(() => {
      expect(samAudioDialogMocks.mockGetSamAudioHealth).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "drums" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Isolate Sound" }));

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(samAudioDialogMocks.mockCancelSeparationJob).toHaveBeenCalledWith(
        "job-1",
      );
    });
  });
});
