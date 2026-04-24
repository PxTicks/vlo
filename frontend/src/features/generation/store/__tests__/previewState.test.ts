import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPreviewFrameExtension,
  getPreviewFrameIndex,
  replacePreviewAnimation,
  revokeJobPostprocessPreview,
} from "../previewState";

describe("previewState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revokes existing animation urls when replacing the animation", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const next = replacePreviewAnimation(
      {
        frameUrls: ["blob:1", null, "blob:2"],
        frameRate: 12,
        totalFrames: 3,
      },
      null,
    );

    expect(next).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(revokeSpy).toHaveBeenCalledWith("blob:1");
    expect(revokeSpy).toHaveBeenCalledWith("blob:2");
  });

  it("uses the explicit preview frame index when present", () => {
    const preview = {
      blob: new Blob(["frame"], { type: "image/png" }),
      frameIndex: 4,
    };

    expect(getPreviewFrameIndex(preview, [])).toBe(4);
    expect(
      getPreviewFrameIndex({ blob: preview.blob }, [new File(["x"], "a.png")]),
    ).toBe(1);
  });

  it("keeps preview frame extensions aligned with image mime types", () => {
    expect(getPreviewFrameExtension("image/jpeg")).toBe("jpg");
    expect(getPreviewFrameExtension("image/webp")).toBe("webp");
    expect(getPreviewFrameExtension("image/bmp")).toBe("bmp");
    expect(getPreviewFrameExtension("image/gif")).toBe("gif");
  });

  it("revokes a postprocessed preview when clearing a job", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    revokeJobPostprocessPreview({
      id: "job",
      status: "completed",
      progress: 100,
      currentNode: null,
      outputs: [],
      error: null,
      submittedAt: 1,
      completedAt: 2,
      postprocessedPreview: {
        previewUrl: "blob:preview",
        mediaKind: "image",
        filename: "preview.png",
      },
    });

    expect(revokeSpy).toHaveBeenCalledWith("blob:preview");
  });
});
