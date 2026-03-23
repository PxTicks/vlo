import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPreviewUpdate,
  completeGenerationJob,
  markActiveJobError,
} from "../jobMutations";

type ErrorState = Parameters<typeof markActiveJobError>[0];
type CompletionState = Parameters<typeof completeGenerationJob>[0];
type PreviewState = Parameters<typeof applyPreviewUpdate>[0];

function makeErrorState(overrides: Partial<ErrorState> = {}): ErrorState {
  return {
    connectionStatus: "connected",
    activeJobId: null,
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    previewAnimation: null,
    ...overrides,
  };
}

function makeCompletionState(
  overrides: Partial<CompletionState> = {},
): CompletionState {
  return {
    activeJobId: null,
    jobs: new Map(),
    previewAnimation: null,
    ...overrides,
  };
}

function makePreviewState(
  overrides: Partial<PreviewState> = {},
): PreviewState {
  return {
    latestPreviewUrl: null,
    previewAnimation: null,
    activeJobId: null,
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    ...overrides,
  };
}

describe("jobMutations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the active job as error and clears preview state", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const state = makeErrorState({
      activeJobId: "job-1",
      previewAnimation: {
        frameUrls: ["blob:1"],
        frameRate: 12,
        totalFrames: 1,
      },
      jobPreviewFrames: new Map([["job-1", [new File(["x"], "frame.png")]]]),
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 20,
            currentNode: "node-1",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
          },
        ],
      ]),
    });

    const patch = markActiveJobError(state, "boom", {
      completedAt: 10,
      nextConnectionStatus: "error",
    });

    expect(patch.activeJobId).toBeNull();
    expect(patch.previewAnimation).toBeNull();
    expect(patch.connectionStatus).toBe("error");
    expect(patch.jobs?.get("job-1")).toMatchObject({
      status: "error",
      error: "boom",
      completedAt: 10,
    });
    expect(revokeSpy).toHaveBeenCalledWith("blob:1");
  });

  it("marks a job completed and clears it as the active job", () => {
    const state = makeCompletionState({
      activeJobId: "job-1",
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 80,
            currentNode: "node-2",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
          },
        ],
      ]),
    });

    const result = completeGenerationJob(state, "job-1");

    expect(result.completedJob).not.toBeNull();
    expect(result.patch.activeJobId).toBeNull();
    expect(result.patch.jobs?.get("job-1")).toMatchObject({
      status: "completed",
      progress: 100,
      currentNode: null,
    });
  });

  it("collects websocket preview frames for SaveImageWebsocket outputs", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:latest");

    const state = makePreviewState({
      activeJobId: "job-1",
      jobs: new Map([
        [
          "job-1",
          {
            id: "job-1",
            status: "running",
            progress: 50,
            currentNode: "save-node",
            outputs: [],
            error: null,
            submittedAt: 1,
            completedAt: null,
            postprocessConfig: {
              mode: "auto",
              panel_preview: "raw_outputs",
              on_failure: "fallback_raw",
            },
            usesSaveImageWebsocketOutputs: true,
            saveImageWebsocketNodeIds: new Set(["save-node"]),
          },
        ],
      ]),
    });

    const patch = applyPreviewUpdate(state, {
      blob: new Blob(["frame"], { type: "image/png" }),
    });

    expect(patch.latestPreviewUrl).toBe("blob:latest");
    expect(patch.jobPreviewFrames?.get("job-1")).toHaveLength(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
