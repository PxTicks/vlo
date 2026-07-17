import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeContent,
  TimelineSelection,
} from "../../../../types/TimelineTypes";

const mocks = vi.hoisted(() => ({
  renderSelectionToVideoFile: vi.fn(),
  getProjectDimensions: vi.fn(() => ({ width: 1919, height: 1079 })),
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
// `mediaSecondsToTick` is intentionally left unmocked (as before this refactor);
// bakeComposite dynamically imports the real implementation.

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

import { bakeComposite } from "../bakeComposite";

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
    mocks.renderSelectionToVideoFile.mockResolvedValue(
      new File(["video"], "composite.webm", { type: "video/webm" }),
    );
    mocks.addLocalAsset.mockResolvedValue({
      id: "baked-asset",
      duration: 2.5,
    } as Asset);
  });

  it("renders project-sized content and registers a private composite asset", async () => {
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
            outputWidth: 1920,
            outputHeight: 1080,
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
          /^v2:content-hash:30fps:1919x1079:transparent:/,
        ),
      }),
      undefined,
      { allowDuplicateHash: false },
    );
    expect(result).toMatchObject({
      asset: { id: "baked-asset" },
      bakedDurationTicks: 240000,
      contentHash: "content-hash",
      bakeKey: expect.stringMatching(
        /^v2:content-hash:30fps:1919x1079:transparent:/,
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

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns no baked duration for %s",
    async (duration) => {
      mocks.addLocalAsset.mockResolvedValue({
        id: "asset",
        duration,
      } as Asset);
      await expect(bakeComposite(content())).resolves.toMatchObject({
        bakedDurationTicks: null,
      });
    },
  );

  it("rejects when the rendered file cannot be registered", async () => {
    mocks.addLocalAsset.mockResolvedValue(null);
    await expect(bakeComposite(content())).rejects.toThrow(
      "Failed to register baked composite asset",
    );
  });
});
