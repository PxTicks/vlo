import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAnimationFrameMock } from "../../../testUtils/animation";
import { resetZustandStore } from "../../../testUtils/zustand";
import { mediaSecondsToTick } from "../../../core/time";
import { MiniEditorModal } from "../MiniEditorModal";
import { MiniEditorPreview } from "../MiniEditorContent";
import type { ResolvedEditorSource } from "../types";
import { useMiniEditorStore } from "../useMiniEditorStore";

function preparedSource(): ResolvedEditorSource {
  return {
    sourceUrl: "blob:preview",
    sourceFile: new File(["video"], "preview.mp4", { type: "video/mp4" }),
    durationTicks: mediaSecondsToTick(5),
  };
}

describe("MiniEditorModal", () => {
  beforeEach(() => {
    resetZustandStore(useMiniEditorStore);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    useMiniEditorStore.getState().close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows preparation and preparation failure states", () => {
    useMiniEditorStore.setState({
      isOpen: true,
      status: "preparing",
      title: "Preparing edit",
    });
    const view = render(<MiniEditorModal />);

    expect(screen.getByText("Preparing asset…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();

    act(() => {
      useMiniEditorStore.setState({
        status: "error",
        error: "Could not decode source",
      });
    });
    expect(screen.getByText("Could not decode source")).toBeInTheDocument();
    view.unmount();
  });

  it("renders a prepared source and updates its measured dimensions", async () => {
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        title: "Edit generated video",
        autoPlay: true,
        prepare: vi.fn(async () => source),
        onSave: vi.fn(),
      });
    });
    render(<MiniEditorModal />);

    expect(screen.getByText("Edit generated video")).toBeInTheDocument();
    expect(screen.getByText(/Crop:/)).toHaveTextContent("0:05.00");
    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("autoplay");
    expect(video).toHaveStyle({ maxHeight: "360px" });
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    fireEvent.loadedMetadata(video as HTMLVideoElement);
    expect(useMiniEditorStore.getState()).toMatchObject({
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
  });

  it("adds, toggles, selects, and removes range masks", async () => {
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onSave: vi.fn(),
      });
    });
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(1));
    render(<MiniEditorModal />);

    fireEvent.click(screen.getByRole("button", { name: "Add range mask" }));
    expect(screen.getByText("Mask 1")).toBeInTheDocument();
    const rangeId = useMiniEditorStore.getState().ranges[0].id;

    fireEvent.click(screen.getByRole("button", { name: "Disable mask 1" }));
    expect(useMiniEditorStore.getState().ranges[0].isActive).toBe(false);
    expect(
      screen.getByRole("button", { name: "Enable mask 1" }),
    ).toBeInTheDocument();

    useMiniEditorStore.getState().selectRange(null);
    fireEvent.click(screen.getByText("Mask 1"));
    expect(useMiniEditorStore.getState().selectedRangeId).toBe(rangeId);

    fireEvent.click(screen.getByRole("button", { name: "Delete mask 1" }));
    expect(useMiniEditorStore.getState().ranges).toEqual([]);
  });

  it("synchronizes native playback, loops at the crop end, and pauses", async () => {
    const animation = installAnimationFrameMock();
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onSave: vi.fn(),
      });
    });
    useMiniEditorStore
      .getState()
      .setCrop(mediaSecondsToTick(1), mediaSecondsToTick(2));
    render(<MiniEditorModal />);
    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 4;

    expect(video).toHaveAttribute("controls");
    fireEvent.play(video);
    await waitFor(() => {
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    });
    expect(video.currentTime).toBe(1);

    video.currentTime = 2.1;
    act(() => animation.flush(16));
    expect(video.currentTime).toBe(1);
    expect(useMiniEditorStore.getState().playheadTicks).toBe(
      mediaSecondsToTick(1),
    );

    fireEvent.pause(video);
    await waitFor(() => {
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    });
    expect(useMiniEditorStore.getState().isPlaying).toBe(false);
  });

  it("synchronizes native audio seeking with the editor playhead", async () => {
    const source = { ...preparedSource(), mediaType: "audio" as const };
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
      });
    });
    render(<MiniEditorModal />);
    const audio = document.querySelector("audio") as HTMLAudioElement;

    fireEvent.play(audio);
    expect(useMiniEditorStore.getState().isPlaying).toBe(true);
    audio.currentTime = 2.5;
    fireEvent.seeked(audio);
    expect(useMiniEditorStore.getState().playheadTicks).toBe(
      mediaSecondsToTick(2.5),
    );
  });

  it("does not navigate assets while an editable control owns the arrow key", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => preparedSource()),
        onPrevious,
        onNext,
        hasPrevious: true,
        hasNext: true,
      });
    });
    render(
      <>
        <input aria-label="Asset title" />
        <MiniEditorPreview />
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Asset title" });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("saves successfully and disables closing while saving", async () => {
    const source = preparedSource();
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => savePromise);
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onSave,
      });
    });
    render(<MiniEditorModal />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => {
      resolveSave();
      await savePromise;
    });
    expect(onSave).toHaveBeenCalledOnce();
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });

  it("cancels and revokes the current source", async () => {
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onSave: vi.fn(),
      });
    });
    render(<MiniEditorModal />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(source.sourceUrl);
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });

  it("selects and confirms a viewer range and frame without closing", async () => {
    const source = preparedSource();
    const onExtractRange = vi.fn(async () => undefined);
    const onExtractFrame = vi.fn(async () => undefined);
    await act(async () => {
      await useMiniEditorStore.getState().open({
        title: "Library video",
        prepare: vi.fn(async () => source),
        onExtractRange,
        onExtractFrame,
      });
    });
    render(<MiniEditorModal />);

    fireEvent.click(screen.getByRole("button", { name: "Extract frame" }));
    expect(onExtractFrame).not.toHaveBeenCalled();
    expect(screen.getByText("Select the frame to extract")).toBeInTheDocument();
    act(() => {
      useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(2));
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm frame extraction" }),
    );
    await waitFor(() => expect(onExtractFrame).toHaveBeenCalledOnce());
    expect(onExtractFrame).toHaveBeenCalledWith(
      mediaSecondsToTick(2),
      source,
    );

    fireEvent.click(screen.getByRole("button", { name: "Extract range" }));
    expect(onExtractRange).not.toHaveBeenCalled();
    expect(screen.getByText("Select the range to extract")).toBeInTheDocument();
    act(() => {
      useMiniEditorStore
        .getState()
        .setCrop(mediaSecondsToTick(1), mediaSecondsToTick(4));
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm range extraction" }),
    );
    await waitFor(() => expect(onExtractRange).toHaveBeenCalledOnce());
    expect(useMiniEditorStore.getState().isOpen).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("cancels an extraction selection and restores its handles", async () => {
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onExtractRange: vi.fn(),
      });
    });
    render(<MiniEditorModal />);

    fireEvent.click(screen.getByRole("button", { name: "Extract range" }));
    act(() => {
      useMiniEditorStore
        .getState()
        .setCrop(mediaSecondsToTick(1), mediaSecondsToTick(3));
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));

    expect(useMiniEditorStore.getState()).toMatchObject({
      extractionMode: null,
      cropStartTicks: 0,
      cropEndTicks: source.durationTicks,
      isOpen: true,
    });
  });

  it("closes an opt-in extraction workflow when Escape is pressed", async () => {
    const source = preparedSource();
    await act(async () => {
      await useMiniEditorStore.getState().open({
        prepare: vi.fn(async () => source),
        onExtractFrame: vi.fn(),
        closeOnExtractionCancel: true,
      });
      useMiniEditorStore.getState().beginFrameExtraction();
    });
    render(<MiniEditorModal />);

    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });

    expect(useMiniEditorStore.getState().isOpen).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(source.sourceUrl);
  });
});
