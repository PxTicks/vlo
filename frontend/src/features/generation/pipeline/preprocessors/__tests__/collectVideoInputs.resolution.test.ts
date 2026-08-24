import { describe, expect, it, vi, beforeEach } from "vitest";

const renderTimelineSelectionToMp4 = vi.fn();
const renderTimelineSelectionToMp4WithDerivedMasks = vi.fn();

vi.mock("../../../utils/inputSelection", () => ({
  renderTimelineSelectionToMp4: (...args: unknown[]) =>
    renderTimelineSelectionToMp4(...args),
  renderTimelineSelectionToMp4WithDerivedMasks: (...args: unknown[]) =>
    renderTimelineSelectionToMp4WithDerivedMasks(...args),
  renderAssetToMaskMp4: vi.fn(),
  getDerivedMaskRenderKey: (mapping: { maskType?: string }) =>
    mapping.maskType === "soft" ? "video_soft" : "video_binary",
}));

import type { TimelineSelection } from "../../../../../types/TimelineTypes";
import { collectVideoInputs } from "../collectVideoInputs";
import type { FrontendPreprocessContext, SlotValue } from "../../types";

function createSelection(
  overrides: Partial<TimelineSelection> = {},
): TimelineSelection {
  return { start: 0, end: 1000, clips: [], tracks: [], ...overrides };
}

function createContext(
  slotValue: SlotValue,
  derivedMaskMappings: FrontendPreprocessContext["derivedMaskMappings"] = [],
): FrontendPreprocessContext {
  return {
    workflowInputs: [{ nodeId: "node-1", param: "video", inputType: "video" }],
    slotValues: { "node-1": slotValue },
    derivedMaskMappings,
    projectConfig: { fps: 30, aspectRatio: "16:9", outputResolution: 1080 },
    videoInputs: {},
    batchInputOptions: {},
  } as unknown as FrontendPreprocessContext;
}

/** The selection the render helper was handed; it carries the resolution. */
function renderedSelection(): TimelineSelection {
  return renderTimelineSelectionToMp4.mock.calls[0][0] as TimelineSelection;
}

describe("collectVideoInputs render resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderTimelineSelectionToMp4.mockResolvedValue(
      new File(["v"], "rendered.mp4"),
    );
  });

  // The helpers derive output size from the selection, so what matters here is
  // that normalization carries the field through to them intact.
  it("carries the selection's resolution into the render", async () => {
    const ctx = createContext({
      type: "video_selection",
      selection: createSelection({ resolution: 720 }),
    });

    await collectVideoInputs.execute(ctx);

    expect(renderedSelection().resolution).toBe(720);
  });

  it("carries a non-rung resolution through unchanged", async () => {
    const ctx = createContext({
      type: "video_selection",
      selection: createSelection({ resolution: 832 }),
    });

    await collectVideoInputs.execute(ctx);

    expect(renderedSelection().resolution).toBe(832);
  });

  describe("prepared-file reuse", () => {
    it("reuses a prepared file when the selection pins a resolution", async () => {
      const preparedVideoFile = new File(["p"], "prepared.mp4");
      const ctx = createContext({
        type: "video_selection",
        selection: createSelection({ resolution: 720 }),
        preparedVideoFile,
      });

      await collectVideoInputs.execute(ctx);

      expect(renderTimelineSelectionToMp4).not.toHaveBeenCalled();
      expect(ctx.videoInputs["node-1"]).toBe(preparedVideoFile);
    });

    // A selection with no resolution follows the project's, which may have
    // changed since the file was prepared — so its size is unknown.
    it("re-renders a prepared file whose selection has no resolution", async () => {
      const ctx = createContext({
        type: "video_selection",
        selection: createSelection(),
        preparedVideoFile: new File(["p"], "prepared.mp4"),
      });

      await collectVideoInputs.execute(ctx);

      expect(renderTimelineSelectionToMp4).toHaveBeenCalledOnce();
      expect(ctx.videoInputs["node-1"]).toEqual(
        expect.objectContaining({ name: "rendered.mp4" }),
      );
    });

    it("re-renders the derived-mask pair when the selection has no resolution", async () => {
      renderTimelineSelectionToMp4WithDerivedMasks.mockResolvedValue({
        video: new File(["v"], "video.mp4"),
        masks: { video_binary: new File(["m"], "mask.mp4") },
        maskContentByKey: { video_binary: true },
      });
      const mapping = {
        maskNodeId: "mask-node",
        maskParam: "file",
        sourceNodeId: "node-1",
        maskType: "binary" as const,
      };
      const ctx = createContext(
        {
          type: "video_selection",
          selection: createSelection(),
          preparedVideoFile: new File(["p"], "prepared.mp4"),
          preparedMaskFile: new File(["pm"], "prepared-mask.mp4"),
          preparedDerivedMaskSignature: null,
        },
        [mapping],
      );

      await collectVideoInputs.execute(ctx);

      // Both halves are withheld: re-rendering only the mask would pair a
      // selection-sized matte with a project-sized video.
      const [, , options] =
        renderTimelineSelectionToMp4WithDerivedMasks.mock.calls[0];
      expect(options).toMatchObject({
        preparedVideoFile: undefined,
        preparedMaskFile: undefined,
      });
    });

    it("reuses the derived-mask pair when the signature and resolution both hold", async () => {
      renderTimelineSelectionToMp4WithDerivedMasks.mockResolvedValue({
        video: new File(["v"], "video.mp4"),
        masks: { video_binary: new File(["m"], "mask.mp4") },
        maskContentByKey: { video_binary: true },
      });
      const mapping = {
        maskNodeId: "mask-node",
        maskParam: "file",
        sourceNodeId: "node-1",
        maskType: "binary" as const,
      };
      const preparedVideoFile = new File(["p"], "prepared.mp4");
      const preparedMaskFile = new File(["pm"], "prepared-mask.mp4");
      const ctx = createContext(
        {
          type: "video_selection",
          selection: createSelection({ resolution: 720 }),
          preparedVideoFile,
          preparedMaskFile,
          preparedDerivedMaskSignature: "video_binary",
        },
        [mapping],
      );

      await collectVideoInputs.execute(ctx);

      const [, , options] =
        renderTimelineSelectionToMp4WithDerivedMasks.mock.calls[0];
      expect(options).toMatchObject({ preparedVideoFile, preparedMaskFile });
    });
  });
});
