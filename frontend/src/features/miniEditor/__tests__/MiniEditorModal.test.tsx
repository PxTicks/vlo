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
import { mediaSecondsToTick } from "../../renderer/utils/mediaTime";
import { MiniEditorModal } from "../MiniEditorModal";
import type { ResolvedEditorSource } from "../types";
import { useMiniEditorStore } from "../useMiniEditorStore";

function preparedSource(): ResolvedEditorSource {
  return {
    videoUrl: "blob:preview",
    videoFile: new File(["video"], "preview.mp4", { type: "video/mp4" }),
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

    expect(screen.getByText("Preparing video…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

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
        prepare: vi.fn(async () => source),
        onSave: vi.fn(),
      });
    });
    render(<MiniEditorModal />);

    expect(screen.getByText("Edit generated video")).toBeInTheDocument();
    expect(screen.getByText(/Crop:/)).toHaveTextContent("0:05.00");
    const video = document.querySelector("video");
    expect(video).not.toBeNull();
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

  it("drives preview playback, loops at the crop end, and pauses", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
    await waitFor(() => {
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    });
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

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(source.videoUrl);
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });
});
