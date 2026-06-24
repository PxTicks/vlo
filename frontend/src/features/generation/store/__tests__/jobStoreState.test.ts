import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchOutputAsFile: vi.fn(),
  addLocalAsset: vi.fn(),
  clearJobEntry: vi.fn(),
}));

vi.mock("../../services/comfyuiApi", () => ({
  fetchOutputAsFile: mocks.fetchOutputAsFile,
}));

vi.mock("../../../userAssets", () => ({
  addLocalAsset: mocks.addLocalAsset,
}));

vi.mock("../jobMutations", () => ({
  clearJobEntry: mocks.clearJobEntry,
}));

import { buildJobStoreState } from "../jobStoreState";

describe("buildJobStoreState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds empty job and preview state", () => {
    const state = buildJobStoreState(vi.fn(), vi.fn() as never);
    expect(state).toMatchObject({
      activeJobId: null,
      latestPreviewUrl: null,
      previewAnimation: null,
    });
    expect(state.jobs).toEqual(new Map());
    expect(state.jobPreviewFrames).toEqual(new Map());
  });

  it("ignores missing jobs and output indexes", async () => {
    const get = vi.fn(() => ({ jobs: new Map() }));
    const state = buildJobStoreState(vi.fn(), get as never);
    await state.importOutput("missing", 0);

    const jobs = new Map([
      ["job-1", { outputs: [] }],
    ]);
    get.mockReturnValue({ jobs });
    await state.importOutput("job-1", 1);
    expect(mocks.fetchOutputAsFile).not.toHaveBeenCalled();
  });

  it("downloads and imports a selected output", async () => {
    const output = {
      filename: "result.png",
      subfolder: "outputs",
      type: "output",
      viewUrl: "/view/result",
    };
    const file = new File(["image"], "result.png");
    mocks.fetchOutputAsFile.mockResolvedValue(file);
    const get = vi.fn(() => ({
      jobs: new Map([["job-1", { outputs: [output] }]]),
    }));
    const state = buildJobStoreState(vi.fn(), get as never);

    await state.importOutput("job-1", 0);

    expect(mocks.fetchOutputAsFile).toHaveBeenCalledWith(
      "result.png",
      "outputs",
      "output",
      "/view/result",
    );
    expect(mocks.addLocalAsset).toHaveBeenCalledWith(file);
  });

  it("clears jobs through the shared mutation helper", () => {
    const set = vi.fn((updater) => updater({ jobs: new Map() }));
    mocks.clearJobEntry.mockReturnValue({ jobs: new Map() });
    const state = buildJobStoreState(set as never, vi.fn() as never);

    state.clearJob("job-1");
    expect(set).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.clearJobEntry).toHaveBeenCalledWith(
      { jobs: new Map() },
      "job-1",
    );
  });
});
