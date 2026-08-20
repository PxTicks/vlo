import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaSecondsToTick } from "../../../../core/time";
import { useMiniEditorStore } from "../../../miniEditor";
import { openDroppedVideoFrameExtraction } from "../droppedVideoFrameExtraction";

const captureVideoFrameFile = vi.fn();

vi.mock("../../../../core/media", () => ({
  captureVideoFrameFile: (...args: unknown[]) => captureVideoFrameFile(...args),
}));

describe("openDroppedVideoFrameExtraction", () => {
  beforeEach(() => {
    useMiniEditorStore.getState().close();
    captureVideoFrameFile.mockReset();
  });

  it("opens directly in frame mode and closing leaves the slot unchanged", async () => {
    const setMediaInputFrame = vi.fn();
    const sourceFile = new File(["video"], "clip.mp4", { type: "video/mp4" });

    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile,
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputFrame,
    });

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      title: "Extract frame: clip.mp4",
      extractionMode: "frame",
      _internal: expect.objectContaining({ closeOnExtractionCancel: true }),
    });

    useMiniEditorStore.getState().close();
    expect(setMediaInputFrame).not.toHaveBeenCalled();
  });

  it("commits the extracted frame and closes the editor on confirmation", async () => {
    const frame = new File(["frame"], "frame.png", { type: "image/png" });
    const setMediaInputFrame = vi.fn();
    captureVideoFrameFile.mockResolvedValue(frame);

    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile: new File(["video"], "clip.mp4", { type: "video/mp4" }),
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputFrame,
    });
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(1.5));

    await useMiniEditorStore.getState().extractFrame();

    expect(captureVideoFrameFile).toHaveBeenCalledWith(
      "blob:clip",
      1.5,
      expect.stringMatching(/^generation-frame-\d+\.png$/),
    );
    expect(setMediaInputFrame).toHaveBeenCalledWith("image-input", frame);
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });
});
