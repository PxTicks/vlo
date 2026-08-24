import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AspectRatio } from "../../../project/useProjectStore";

const projectConfig = {
  aspectRatio: "16:9" as AspectRatio,
  outputResolution: 1080,
  fps: 30,
};

vi.mock("../../../project", () => ({
  useProjectStore: {
    getState: () => ({ config: projectConfig }),
  },
}));

vi.mock("../../../timeline/api", () => ({
  getTimelineClips: () => [],
  getTimelineDuration: () => 0,
  getTimelineTracks: () => [],
  getTimelineTransitions: () => [],
}));

vi.mock("../../../userAssets", () => ({ getAssets: () => [] }));
vi.mock("../../../composite", () => ({ getCompositeAssets: () => [] }));
vi.mock("../../../masks/api", () => ({
  prepareBrushMasksForTimelineRender: vi.fn(),
}));
vi.mock("../ExportRenderer", () => ({ ExportRenderer: { create: vi.fn() } }));

import { buildProjectRenderInputs } from "../projectFrameCapture";

const setAspectRatio = (ratio: AspectRatio) => {
  projectConfig.aspectRatio = ratio;
};

const setOutputResolution = (shortEdge: number) => {
  projectConfig.outputResolution = shortEdge;
};

describe("buildProjectRenderInputs", () => {
  beforeEach(() => {
    setAspectRatio("16:9");
    setOutputResolution(1080);
  });

  it("renders a portrait project at the true short-edge resolution", () => {
    setAspectRatio("9:16");
    const { exportConfig } = buildProjectRenderInputs();

    // Logical stays the stored coordinate space; output is the real frame.
    expect(exportConfig.logicalWidth).toBe(608);
    expect(exportConfig.logicalHeight).toBe(1080);
    expect(exportConfig.outputWidth).toBe(1080);
    expect(exportConfig.outputHeight).toBe(1920);
  });

  it("leaves output equal to logical for 16:9", () => {
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(exportConfig.logicalWidth);
    expect(exportConfig.outputHeight).toBe(exportConfig.logicalHeight);
    expect(exportConfig.outputWidth).toBe(1920);
    expect(exportConfig.outputHeight).toBe(1080);
  });

  it("keeps the logical canvas untouched for 3:4 while widening the output", () => {
    setAspectRatio("3:4");
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.logicalWidth).toBe(810);
    expect(exportConfig.outputWidth).toBe(1080);
    expect(exportConfig.outputHeight).toBe(1440);
  });
});

describe("buildProjectRenderInputs output resolution", () => {
  beforeEach(() => {
    setAspectRatio("16:9");
    setOutputResolution(1080);
  });

  it("renders at the project's chosen short edge", () => {
    setOutputResolution(720);
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(1280);
    expect(exportConfig.outputHeight).toBe(720);
  });

  it("applies the project resolution in portrait too", () => {
    setAspectRatio("9:16");
    setOutputResolution(720);
    const { exportConfig } = buildProjectRenderInputs();

    expect(exportConfig.outputWidth).toBe(720);
    expect(exportConfig.outputHeight).toBe(1280);
  });

  it("leaves the logical canvas untouched by the resolution", () => {
    setAspectRatio("9:16");
    const at1080 = buildProjectRenderInputs().exportConfig;
    setOutputResolution(2160);
    const at2160 = buildProjectRenderInputs().exportConfig;

    // The coordinate space is fixed-height by definition; only output moves.
    expect(at2160.logicalWidth).toBe(at1080.logicalWidth);
    expect(at2160.logicalHeight).toBe(at1080.logicalHeight);
    expect(at2160.outputWidth).toBe(2160);
    expect(at2160.outputHeight).toBe(3840);
  });
});
