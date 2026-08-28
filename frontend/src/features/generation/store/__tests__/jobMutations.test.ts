import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPreviewUpdate,
  markActiveJobError,
  resolveActiveJobId,
} from "../jobMutations";
import type { GenerationJob } from "../../types";

type ErrorState = Parameters<typeof markActiveJobError>[0];
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

  it("ignores preview packets that belong to another prompt", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:ignored");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const patch = applyPreviewUpdate(
      makePreviewState({
        activeJobId: "job-1",
        latestPreviewUrl: "blob:current",
        jobs: new Map([
          [
            "job-1",
            {
              id: "job-1",
              status: "running",
              progress: 50,
              currentNode: "node-1",
              outputs: [],
              error: null,
              submittedAt: 1,
              completedAt: null,
            },
          ],
        ]),
      }),
      {
        blob: new Blob(["frame"], { type: "image/png" }),
        promptId: "job-2",
      },
    );

    expect(patch).toEqual({});
    expect(createSpy).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

describe("resolveActiveJobId", () => {
  function job(
    id: string,
    status: GenerationJob["status"],
    submittedAt: number,
  ): GenerationJob {
    return {
      id,
      deliveryId: null,
      status,
      progress: 0,
      currentNode: null,
      outputs: [],
      error: null,
      submittedAt,
      completedAt: null,
    } as unknown as GenerationJob;
  }

  function jobMap(...entries: GenerationJob[]): Map<string, GenerationJob> {
    return new Map(entries.map((entry) => [entry.id, entry]));
  }

  it("prefers the running prompt over queued siblings", () => {
    // ComfyUI runs one prompt at a time; that prompt owns the preview pane no
    // matter how many of ours are queued behind it.
    const jobs = jobMap(
      job("queued-first", "queued", 1),
      job("running", "running", 2),
      job("queued-last", "queued", 3),
    );
    expect(resolveActiveJobId(jobs, "queued-last")).toBe("running");
  });

  it("keeps the running prompt when a queued sibling updates", () => {
    const jobs = jobMap(job("running", "running", 1), job("queued", "queued", 2));
    expect(resolveActiveJobId(jobs, "running")).toBe("running");
  });

  it("falls back to the oldest queued prompt once nothing is running", () => {
    const jobs = jobMap(
      job("done", "completed", 1),
      job("queued-late", "queued", 3),
      job("queued-early", "queued", 2),
    );
    expect(resolveActiveJobId(jobs, "done")).toBe("queued-early");
  });

  it("holds a chosen queued prompt rather than reshuffling on each update", () => {
    const jobs = jobMap(job("queued-early", "queued", 1), job("queued-late", "queued", 2));
    expect(resolveActiveJobId(jobs, "queued-late")).toBe("queued-late");
  });

  it("returns null when nothing is in flight", () => {
    expect(resolveActiveJobId(jobMap(job("done", "completed", 1)), "done")).toBeNull();
  });
});
