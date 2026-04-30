import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnsureAssetFileLoaded } = vi.hoisted(() => ({
  mockEnsureAssetFileLoaded: vi.fn(),
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetFileLoaded: mockEnsureAssetFileLoaded,
}));

import {
  hasProvidedMediaInputValue,
  resolveAssetFileForGeneration,
} from "../mediaInputAssets";

describe("mediaInputAssets", () => {
  beforeEach(() => {
    mockEnsureAssetFileLoaded.mockReset();
    globalThis.fetch = vi.fn();
  });

  it("treats lazy video assets as provided workflow inputs", () => {
    expect(
      hasProvidedMediaInputValue("video", {
        kind: "asset",
        asset: {
          id: "asset-1",
          hash: "hash",
          name: "clip.mp4",
          type: "video",
          src: "assets/clip.mp4",
          createdAt: Date.now(),
        },
      }),
    ).toBe(true);
  });

  it("treats dragged image assets as provided even when stored asset.type is stale", () => {
    expect(
      hasProvidedMediaInputValue("image", {
        kind: "asset",
        asset: {
          id: "asset-legacy-image",
          hash: "hash-image",
          name: "frame.png",
          type: "video",
          src: "assets/frame.png",
          createdAt: Date.now(),
        },
      }),
    ).toBe(true);
  });

  it("treats an in-flight video timeline-selection extraction as a provided input", () => {
    const baseSelection = {
      kind: "timelineSelection" as const,
      mediaType: "video" as const,
      timelineSelection: {
        start: 0,
        end: 100,
        clips: [],
      } as never,
      thumbnailFile: new File([""], "thumb.png", { type: "image/png" }),
      thumbnailUrl: "blob:thumb",
      isExtracting: true,
      extractionRequestId: 1,
      extractionError: null,
      preparedVideoFile: null,
      preparedMaskFile: null,
    };

    expect(hasProvidedMediaInputValue("video", baseSelection)).toBe(true);

    expect(
      hasProvidedMediaInputValue("video", {
        ...baseSelection,
        isExtracting: false,
        preparedVideoFile: new File([""], "v.mp4", { type: "video/mp4" }),
      }),
    ).toBe(true);

    expect(
      hasProvidedMediaInputValue("video", {
        ...baseSelection,
        isExtracting: false,
        preparedVideoFile: null,
        extractionError: "boom",
      }),
    ).toBe(false);
  });

  it("does not treat ambiguous asset metadata as a valid filled input", () => {
    expect(
      hasProvidedMediaInputValue("image", {
        kind: "asset",
        asset: {
          id: "asset-ambiguous",
          hash: "hash-ambiguous",
          name: "source",
          type: "video",
          src: "blob:runtime-source",
          createdAt: Date.now(),
        },
      }),
    ).toBe(false);
  });

  it("hydrates generation asset files from the asset store before falling back to fetch", async () => {
    const hydratedFile = new File(["video"], "hydrated.mp4", {
      type: "video/mp4",
    });
    mockEnsureAssetFileLoaded.mockResolvedValue(hydratedFile);

    await expect(
      resolveAssetFileForGeneration({
        id: "asset-1",
        file: undefined,
        src: "assets/clip.mp4",
        name: "clip.mp4",
        type: "video",
      }),
    ).resolves.toBe(hydratedFile);

    expect(mockEnsureAssetFileLoaded).toHaveBeenCalledWith("asset-1");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("falls back to fetching the asset source when no hydrated file exists", async () => {
    mockEnsureAssetFileLoaded.mockResolvedValue(null);
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/webp" }),
    } as Response);

    const file = await resolveAssetFileForGeneration({
      id: "asset-2",
      file: undefined,
      src: "blob:image-asset",
      name: "frame.webp",
      type: "image",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("blob:image-asset");
    expect(file.name).toBe("frame.webp");
    expect(file.type).toBe("image/webp");
  });
});
