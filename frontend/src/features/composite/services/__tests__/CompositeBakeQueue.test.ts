import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { CompositeContent } from "../../../../types/TimelineTypes";
import {
  CompositeBakeQueue,
  type CompositeBakeQueueCallbacks,
  type CompositeBakeRequest,
} from "../CompositeBakeQueue";
import type { BakeCompositeOptions, BakedComposite } from "../bakeComposite";

const content: CompositeContent = {
  clips: [],
  tracks: [],
  durationTicks: 100,
};

function request(
  compositeId: string,
  revision: number,
): CompositeBakeRequest {
  return {
    compositeId,
    projectId: "project-1",
    revision,
    requestedKey: `${compositeId}-key-${revision}`,
    content,
  };
}

function result(id: string): BakedComposite {
  return {
    asset: {
      id,
      hash: `${id}-hash`,
      name: `${id}.webm`,
      type: "video",
      src: `blob:${id}`,
      duration: 1,
      createdAt: 1,
    } satisfies Asset,
    contentHash: `${id}-content`,
    bakeKey: id.replace("asset", "composite-key"),
  };
}

function callbacks(): CompositeBakeQueueCallbacks {
  return {
    onStarted: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onCancelled: vi.fn(),
    disposeResult: vi.fn(),
  };
}

describe("CompositeBakeQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds concurrency while allowing different composites to queue", async () => {
    const releases: Array<(value: BakedComposite) => void> = [];
    const bake = vi.fn(
      (_content: CompositeContent, _options: BakeCompositeOptions) =>
        new Promise<BakedComposite>((resolve) => {
          releases.push(resolve);
        }),
    );
    const queue = new CompositeBakeQueue({ maxConcurrent: 1, bake });
    const firstCallbacks = callbacks();
    const secondCallbacks = callbacks();

    queue.enqueue(request("composite-a", 1), firstCallbacks);
    queue.enqueue(request("composite-b", 1), secondCallbacks);
    await vi.waitFor(() => expect(bake).toHaveBeenCalledTimes(1));
    expect(queue.activeJobCount).toBe(1);
    expect(queue.queuedJobCount).toBe(1);

    releases[0](result("asset-a"));
    await vi.waitFor(() => expect(bake).toHaveBeenCalledTimes(2));
    releases[1](result("asset-b"));
    await queue.whenIdle();

    expect(firstCallbacks.onCompleted).toHaveBeenCalledOnce();
    expect(secondCallbacks.onCompleted).toHaveBeenCalledOnce();
  });

  it("coalesces queued revisions and never starts the superseded request", async () => {
    let releaseActive: (value: BakedComposite) => void = () => undefined;
    const bake = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<BakedComposite>((resolve) => {
            releaseActive = resolve;
          }),
      )
      .mockResolvedValueOnce(result("asset-latest"));
    const queue = new CompositeBakeQueue({ maxConcurrent: 1, bake });
    queue.enqueue(request("blocker", 1), callbacks());
    await vi.waitFor(() => expect(bake).toHaveBeenCalledOnce());

    const staleCallbacks = callbacks();
    const latestCallbacks = callbacks();
    queue.enqueue(request("composite", 1), staleCallbacks);
    queue.enqueue(request("composite", 2), latestCallbacks);
    expect(staleCallbacks.onCancelled).toHaveBeenCalledOnce();

    releaseActive(result("asset-blocker"));
    await queue.whenIdle();
    expect(bake).toHaveBeenCalledTimes(2);
    expect(bake.mock.calls[1]?.[1]).toMatchObject({
      compositeRevision: 2,
    });
    expect(staleCallbacks.onCompleted).not.toHaveBeenCalled();
    expect(latestCallbacks.onCompleted).toHaveBeenCalledOnce();
  });

  it("aborts active stale work and disposes a result that completes late", async () => {
    const releases: Array<(value: BakedComposite) => void> = [];
    const bake = vi.fn(
      (_content: CompositeContent, _options: BakeCompositeOptions) =>
        new Promise<BakedComposite>((resolve) => {
          releases.push(resolve);
        }),
    );
    const queue = new CompositeBakeQueue({ maxConcurrent: 1, bake });
    const staleCallbacks = callbacks();
    const latestCallbacks = callbacks();
    queue.enqueue(request("composite", 1), staleCallbacks);
    await vi.waitFor(() => expect(bake).toHaveBeenCalledOnce());
    const firstSignal = bake.mock.calls[0]?.[1].signal;

    queue.enqueue(request("composite", 2), latestCallbacks);
    expect(firstSignal?.aborted).toBe(true);
    releases[0](result("asset-stale"));
    await vi.waitFor(() => expect(bake).toHaveBeenCalledTimes(2));
    releases[1](result("asset-latest"));
    await queue.whenIdle();

    expect(staleCallbacks.disposeResult).toHaveBeenCalledWith(
      expect.objectContaining({ asset: expect.objectContaining({ id: "asset-stale" }) }),
    );
    expect(staleCallbacks.onCompleted).not.toHaveBeenCalled();
    expect(latestCallbacks.onCompleted).toHaveBeenCalledOnce();
  });

  it("does not overlap revisions of one composite when concurrency is greater than one", async () => {
    const releases = new Map<string, (value: BakedComposite) => void>();
    const bake = vi.fn(
      (_content: CompositeContent, options: BakeCompositeOptions) =>
        new Promise<BakedComposite>((resolve) => {
          releases.set(
            `${options.compositeAssetId}:${options.compositeRevision}`,
            resolve,
          );
        }),
    );
    const queue = new CompositeBakeQueue({ maxConcurrent: 2, bake });
    const staleCallbacks = callbacks();
    const latestCallbacks = callbacks();

    queue.enqueue(request("composite", 1), staleCallbacks);
    queue.enqueue(request("blocker", 1), callbacks());
    await vi.waitFor(() => expect(bake).toHaveBeenCalledTimes(2));

    queue.enqueue(request("composite", 2), latestCallbacks);
    releases.get("blocker:1")?.(result("asset-blocker"));
    await vi.waitFor(() => expect(queue.activeJobCount).toBe(1));
    expect(bake).toHaveBeenCalledTimes(2);

    releases.get("composite:1")?.(result("asset-stale"));
    await vi.waitFor(() => expect(bake).toHaveBeenCalledTimes(3));
    expect(bake.mock.calls[2]?.[1]).toMatchObject({
      compositeAssetId: "composite",
      compositeRevision: 2,
    });
    releases.get("composite:2")?.(result("asset-latest"));
    await queue.whenIdle();

    expect(staleCallbacks.onCompleted).not.toHaveBeenCalled();
    expect(latestCallbacks.onCompleted).toHaveBeenCalledOnce();
  });

  it("reports failures but treats cancellation as non-failure", async () => {
    const failure = new Error("encoder failed");
    const failedCallbacks = callbacks();
    const cancelledCallbacks = callbacks();
    const queue = new CompositeBakeQueue({
      bake: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockImplementationOnce(
          (_content, options) =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(new DOMException("cancelled", "AbortError"));
              });
            }),
        ),
    });

    queue.enqueue(request("failed", 1), failedCallbacks);
    await queue.whenIdle();
    expect(failedCallbacks.onFailed).toHaveBeenCalledWith(
      expect.anything(),
      failure,
    );

    queue.enqueue(request("cancelled", 1), cancelledCallbacks);
    await vi.waitFor(() => expect(queue.activeJobCount).toBe(1));
    queue.cancelAll();
    await queue.whenIdle();
    expect(cancelledCallbacks.onCancelled).toHaveBeenCalledOnce();
    expect(cancelledCallbacks.onFailed).not.toHaveBeenCalled();
  });
});
