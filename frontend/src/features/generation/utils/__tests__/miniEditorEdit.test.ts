import { beforeEach, describe, expect, it, vi } from "vitest";

const renderTimelineSelectionToMp4 = vi.fn();
const renderTimelineSelectionToMp4WithMask = vi.fn();

const renderTimelineSelectionToMaskOutput = vi.fn();

vi.mock("../inputSelection", () => ({
  renderTimelineSelectionToMp4: (...args: unknown[]) =>
    renderTimelineSelectionToMp4(...args),
  renderTimelineSelectionToMp4WithMask: (...args: unknown[]) =>
    renderTimelineSelectionToMp4WithMask(...args),
  renderTimelineSelectionToMaskOutput: (...args: unknown[]) =>
    renderTimelineSelectionToMaskOutput(...args),
}));

import type { ProjectData } from "../../../renderer";
import type { ResolvedEditorSource } from "../../../miniEditor";
import { renderSyntheticEditedOutputs } from "../miniEditorEdit";

function createSource(
  overrides: Partial<ResolvedEditorSource> = {},
): ResolvedEditorSource {
  return {
    sourceUrl: "blob:source",
    sourceFile: new File(["v"], "source.mp4", { type: "video/mp4" }),
    durationTicks: 10_000,
    ...overrides,
  };
}

const spec = { cropStartTicks: 0, cropEndTicks: 5_000, ranges: [] };
const dims = { width: 640, height: 480 };

function renderedProjectData(mock: ReturnType<typeof vi.fn>): ProjectData {
  const options = mock.mock.calls[0].at(-1) as {
    renderInputs: { projectData: ProjectData };
  };
  return options.renderInputs.projectData;
}

describe("renderSyntheticEditedOutputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderTimelineSelectionToMp4.mockResolvedValue(new File(["v"], "video.mp4"));
    renderTimelineSelectionToMp4WithMask.mockResolvedValue({
      video: new File(["v"], "video.mp4"),
      mask: new File(["m"], "mask.mp4"),
      maskHasVisibleContent: true,
    });
    renderTimelineSelectionToMaskOutput.mockResolvedValue({
      file: new File(["s"], "soft-mask.mp4"),
      hasVisibleContent: false,
    });
  });

  // The export renderer resolves clip audio through the asset store by id, so
  // a fabricated id would bake the edit without its soundtrack.
  it("bakes against the library asset's own id so audio resolves", async () => {
    await renderSyntheticEditedOutputs(spec, createSource({ assetId: "asset-1" }), dims);

    const projectData = renderedProjectData(renderTimelineSelectionToMp4);
    expect(projectData.assets[0].id).toBe("asset-1");
    expect(
      (projectData.clips[0] as { assetId?: string }).assetId,
    ).toBe("asset-1");
  });

  it("falls back to a synthetic id when the source has no asset", async () => {
    await renderSyntheticEditedOutputs(spec, createSource(), dims);

    const projectData = renderedProjectData(renderTimelineSelectionToMp4);
    expect(projectData.assets[0].id).toMatch(/^mini_editor_source_/);
  });

  // A workflow with a derived-mask input must receive a matte on every
  // submission; the bake is this input's only render.
  it("renders the requested matte even when no range is active", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [{ key: "video_soft", maskType: "soft" }],
    });

    expect(renderTimelineSelectionToMp4).not.toHaveBeenCalled();
    expect(renderTimelineSelectionToMp4WithMask.mock.calls[0][1]).toBe("soft");
    expect(result.masks.video_soft).toBeDefined();
    expect(result.maskContentByKey.video_soft).toBe(true);
  });

  it("carries the mapping's source video treatment into the pair render", async () => {
    await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [
        {
          key: "video_binary",
          maskType: "binary",
          sourceVideoTreatment: "preserve_transparency",
        },
      ],
    });

    expect(renderTimelineSelectionToMp4WithMask.mock.calls[0][2]).toMatchObject({
      sourceVideoTreatment: "preserve_transparency",
    });
  });

  // Binary and soft mappings on one source are two different mattes.
  it("renders one matte per distinct render key", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [
        { key: "video_binary", maskType: "binary" },
        { key: "video_soft", maskType: "soft" },
        { key: "video_binary", maskType: "binary" },
      ],
    });

    expect(renderTimelineSelectionToMp4WithMask).toHaveBeenCalledOnce();
    expect(renderTimelineSelectionToMaskOutput).toHaveBeenCalledOnce();
    expect(result.masks.video_binary?.name).toBe("mask.mp4");
    expect(result.masks.video_soft?.name).toBe("soft-mask.mp4");
    expect(result.maskContentByKey).toEqual({
      video_binary: true,
      video_soft: false,
    });
  });

  it("rejects mappings that disagree on the source video treatment", async () => {
    await expect(
      renderSyntheticEditedOutputs(spec, createSource(), dims, {
        maskRequests: [
          { key: "video_binary", maskType: "binary" },
          {
            key: "video_soft",
            maskType: "soft",
            sourceVideoTreatment: "preserve_transparency",
          },
        ],
      }),
    ).rejects.toThrow(/conflicting source video treatments/);
  });

  it("bakes the ranges into the video when nothing asks for a matte", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims);

    expect(renderTimelineSelectionToMp4WithMask).not.toHaveBeenCalled();
    expect(result.masks).toEqual({});
  });
});
