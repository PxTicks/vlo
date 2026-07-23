import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeContent,
  TimelineSelection,
} from "../../../../types/TimelineTypes";

const mocks = vi.hoisted(() => ({
  renderSelectionToVideoFile: vi.fn(),
  getProjectDimensions: vi.fn(() => ({ width: 1919, height: 1079 })),
  resolveCompositeRasterDimensionsForContent: vi.fn(async () => ({
    width: 1280,
    height: 720,
  })),
  compositeContentToSelection: vi.fn<() => TimelineSelection>(() => ({
    start: 0,
    end: 100,
    clips: [],
  })),
  hashCompositeContent: vi.fn(() => "content-hash"),
  getAssets: vi.fn(() => [{ id: "asset-1" }]),
  addLocalAsset: vi.fn(),
  getTimelineTracks: vi.fn(() => [{ id: "fallback-track" }]),
  projectState: {
    config: { aspectRatio: "16:9", fps: 24 },
  },
}));

// bakeComposite dynamically imports these renderer subpaths to avoid a static
// composite -> renderer import edge, so mock the concrete modules it loads.
vi.mock("../../../renderer/services/renderSelectionToVideoFile", () => ({
  renderSelectionToVideoFile: mocks.renderSelectionToVideoFile,
}));

vi.mock("../../../renderer/utils/dimensions", () => ({
  getProjectDimensions: mocks.getProjectDimensions,
}));
vi.mock("../../../renderer/utils/compositeRasterDimensions", () => ({
  resolveCompositeRasterDimensionsForContent:
    mocks.resolveCompositeRasterDimensionsForContent,
}));
vi.mock("../../../timelineSelection", () => ({
  compositeContentToSelection: mocks.compositeContentToSelection,
  hashCompositeContent: mocks.hashCompositeContent,
}));

vi.mock("../../../project/useProjectStore", () => ({
  useProjectStore: {
    getState: () => mocks.projectState,
  },
}));

vi.mock("../../../userAssets", () => ({
  getAssets: mocks.getAssets,
  addLocalAsset: mocks.addLocalAsset,
}));

vi.mock("../../../timeline/api", () => ({
  getTimelineTracks: mocks.getTimelineTracks,
}));

import {
  bakeComposite,
  renderCompositeToVideoFile,
} from "../bakeComposite";

function content(overrides: Partial<CompositeContent> = {}): CompositeContent {
  return {
    clips: [],
    tracks: [{ id: "content-track" }],
    durationTicks: 96000,
    fps: 30,
    ...overrides,
  } as CompositeContent;
}

describe("bakeComposite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectState.config = { aspectRatio: "16:9", fps: 24 };
    mocks.resolveCompositeRasterDimensionsForContent.mockResolvedValue({
      width: 1280,
      height: 720,
    });
    mocks.renderSelectionToVideoFile.mockResolvedValue(
      new File(["video"], "composite.webm", { type: "video/webm" }),
    );
    mocks.addLocalAsset.mockResolvedValue({
      id: "baked-asset",
      duration: 2.5,
    } as Asset);
  });

  it("renders at the adaptive composite raster and registers a private composite asset", async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const onBeforeEncodeFrame = vi.fn();
    const sourceContent = content();

    const result = await bakeComposite(sourceContent, {
      signal: controller.signal,
      onProgress,
      compositeAssetId: "composite-1",
      compositeClipId: "clip-1",
      compositeRevision: 7,
      allowDuplicateHash: false,
      onBeforeEncodeFrame,
    });

    expect(mocks.renderSelectionToVideoFile).toHaveBeenCalledWith(
      expect.objectContaining({ start: 0, end: 100 }),
      {
        renderInputs: {
          exportConfig: {
            logicalWidth: 1919,
            logicalHeight: 1079,
            outputWidth: 1280,
            outputHeight: 720,
            backgroundAlpha: 0,
          },
          projectData: {
            tracks: sourceContent.tracks,
            clips: sourceContent.clips,
            composites: [],
            assets: [{ id: "asset-1" }],
            duration: 96000,
            fps: 30,
          },
        },
        signal: controller.signal,
        onProgress,
        filenamePrefix: "composite",
        format: "webm",
        keyFrameInterval: 1,
        preserveAlpha: true,
        onBeforeEncodeFrame,
      },
    );
    expect(mocks.addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        source: "composite",
        compositeAssetId: "composite-1",
        compositeClipId: "clip-1",
        compositeRevision: 7,
        contentHash: "content-hash",
        bakeKey: expect.stringMatching(
          /^v4:content-hash:30fps:1919x1079:transparent:1s-gop:/,
        ),
      }),
      undefined,
      { allowDuplicateHash: false },
    );
    expect(result).toMatchObject({
      asset: { id: "baked-asset" },
      contentHash: "content-hash",
      bakeKey: expect.stringMatching(
        /^v4:content-hash:30fps:1919x1079:transparent:1s-gop:/,
      ),
    });
  });

  it("falls back to timeline tracks and project FPS", async () => {
    await bakeComposite(
      content({
        tracks: undefined,
        fps: 0,
      }),
    );

    expect(mocks.getTimelineTracks).toHaveBeenCalled();
    expect(mocks.renderSelectionToVideoFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        renderInputs: expect.objectContaining({
          projectData: expect.objectContaining({
            tracks: [{ id: "fallback-track" }],
            fps: 24,
          }),
        }),
      }),
    );
    expect(mocks.addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.not.objectContaining({
        compositeAssetId: expect.anything(),
        compositeClipId: expect.anything(),
      }),
      undefined,
      { allowDuplicateHash: true },
    );
  });

  it("preserves an explicitly supplied zero revision in bake metadata", async () => {
    await bakeComposite(content(), { compositeRevision: 0 });

    expect(mocks.addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ compositeRevision: 0 }),
      undefined,
      expect.anything(),
    );
  });

  it("renders every playback frame without overwriting authored selection metadata", async () => {
    const authoredSelection = {
      start: 0,
      end: 96000,
      clips: [],
      frameStep: 4,
    };
    mocks.compositeContentToSelection.mockReturnValueOnce(authoredSelection);

    await bakeComposite(content({ frameStep: 4 }));

    expect(mocks.renderSelectionToVideoFile).toHaveBeenCalledWith(
      { ...authoredSelection, frameStep: 1 },
      expect.anything(),
    );
    expect(mocks.addLocalAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ timelineSelection: authoredSelection }),
      undefined,
      expect.anything(),
    );
  });

  it("returns only bytes for a bounded render, not a canonical bake identity", async () => {
    const renderedFile = new File(["probe"], "probe.webm", {
      type: "video/webm",
    });
    mocks.renderSelectionToVideoFile.mockResolvedValueOnce(renderedFile);
    const selection = { start: 25, end: 50, clips: [] };

    const result = await renderCompositeToVideoFile(content(), { selection });

    expect(result).toBe(renderedFile);
    expect(mocks.renderSelectionToVideoFile).toHaveBeenCalledWith(
      { ...selection, frameStep: 1 },
      expect.anything(),
    );
  });

  it("rejects when the rendered file cannot be registered", async () => {
    mocks.addLocalAsset.mockResolvedValue(null);
    await expect(bakeComposite(content())).rejects.toThrow(
      "Failed to register baked composite asset",
    );
  });
});
