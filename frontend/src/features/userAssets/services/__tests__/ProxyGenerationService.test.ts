import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { projectMutationGuard } from "../../../../core/project/projectMutationGuard";
import { runProjectClosingHooks } from "../../../../core/project/projectLifecycleHooks";
import {
  ProxyGenerationService,
  needsProxy,
  proxyGenerationService,
  type ProxyJob,
} from "../ProxyGenerationService";

const { generateProxyVideo } = vi.hoisted(() => ({
  generateProxyVideo: vi.fn(),
}));

vi.mock("../MediaProcessingService", () => ({
  mediaProcessingService: { generateProxyVideo },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeJob(assetId: string) {
  return {
    assetId,
    assetName: `${assetId}.mp4`,
    loadSource: vi.fn(async () => new File(["source"], `${assetId}.mp4`)),
    commit: vi.fn<ProxyJob["commit"]>(async () => undefined),
  };
}

/** Resolves a running conversion with null once its signal aborts. */
function generateUntilAborted(_file: File, options: { signal?: AbortSignal }) {
  return new Promise<Blob | null>((resolve) => {
    options.signal?.addEventListener("abort", () => resolve(null));
  });
}

describe("ProxyGenerationService", () => {
  beforeEach(() => {
    generateProxyVideo.mockReset();
    generateProxyVideo.mockResolvedValue(new Blob(["proxy"]));
  });

  it("transcodes one asset at a time, in arrival order", async () => {
    const first = deferred<Blob | null>();
    generateProxyVideo.mockImplementationOnce(() => first.promise);
    const service = new ProxyGenerationService();
    const a = makeJob("a");
    const b = makeJob("b");

    service.enqueue(a);
    service.enqueue(b);
    await vi.waitFor(() => expect(generateProxyVideo).toHaveBeenCalledTimes(1));
    expect(b.loadSource).not.toHaveBeenCalled();

    const proxyA = new Blob(["proxy-a"]);
    first.resolve(proxyA);
    await service.whenIdle();

    expect(a.commit).toHaveBeenCalledWith(proxyA, expect.any(AbortSignal));
    expect(b.commit).toHaveBeenCalledTimes(1);
    expect(generateProxyVideo).toHaveBeenCalledTimes(2);
  });

  it("ignores an asset that is already queued", async () => {
    const service = new ProxyGenerationService();
    const job = makeJob("a");

    service.enqueue(job);
    service.enqueue(makeJob("a"));
    await service.whenIdle();

    expect(generateProxyVideo).toHaveBeenCalledTimes(1);
    expect(job.commit).toHaveBeenCalledTimes(1);
  });

  it("aborts the running conversion on cancel and drops its result", async () => {
    generateProxyVideo.mockImplementationOnce(generateUntilAborted);
    const service = new ProxyGenerationService();
    const job = makeJob("a");

    service.enqueue(job);
    await vi.waitFor(() => expect(generateProxyVideo).toHaveBeenCalledTimes(1));
    service.cancel("a");
    await service.whenIdle();

    expect(job.commit).not.toHaveBeenCalled();

    // A cancel is not a failure: the asset can be queued again.
    service.enqueue(job);
    await service.whenIdle();
    expect(job.commit).toHaveBeenCalledTimes(1);
  });

  it("drops a queued job on cancel without starting it", async () => {
    const first = deferred<Blob | null>();
    generateProxyVideo.mockImplementationOnce(() => first.promise);
    const service = new ProxyGenerationService();
    const a = makeJob("a");
    const b = makeJob("b");

    service.enqueue(a);
    service.enqueue(b);
    service.cancel("b");
    first.resolve(new Blob(["proxy-a"]));
    await service.whenIdle();

    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(b.loadSource).not.toHaveBeenCalled();
  });

  it("does not retry a failed asset in the same session", async () => {
    generateProxyVideo.mockResolvedValueOnce(null);
    const service = new ProxyGenerationService();
    const job = makeJob("a");

    service.enqueue(job);
    await service.whenIdle();
    service.enqueue(job);
    await service.whenIdle();

    expect(job.loadSource).toHaveBeenCalledTimes(1);
    expect(job.commit).not.toHaveBeenCalled();
  });

  it("waits for a running export before starting", async () => {
    const service = new ProxyGenerationService();
    const job = makeJob("a");
    const lease = await projectMutationGuard.acquire();

    try {
      service.enqueue(job);
      await Promise.resolve();
      await Promise.resolve();
      expect(job.loadSource).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }

    await vi.waitFor(() => expect(job.commit).toHaveBeenCalledTimes(1));
  });

  it("stops a running transcode when an export starts and redoes it afterwards", async () => {
    generateProxyVideo.mockImplementationOnce(generateUntilAborted);
    const service = new ProxyGenerationService();
    const job = makeJob("a");

    service.enqueue(job);
    await vi.waitFor(() => expect(generateProxyVideo).toHaveBeenCalledTimes(1));
    const lease = await projectMutationGuard.acquire();

    try {
      // The conversion was stopped for the export and is not retried during it.
      const firstSignal = generateProxyVideo.mock.calls[0][1].signal as AbortSignal;
      expect(firstSignal.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(generateProxyVideo).toHaveBeenCalledTimes(1);
      expect(service.has("a")).toBe(true);
    } finally {
      lease.release();
    }

    await vi.waitFor(() => expect(job.commit).toHaveBeenCalledTimes(1));
    expect(generateProxyVideo).toHaveBeenCalledTimes(2);
  });

  it("cancels every job when the project closes", async () => {
    generateProxyVideo.mockImplementationOnce(generateUntilAborted);
    const a = makeJob("closing-a");
    const b = makeJob("closing-b");

    proxyGenerationService.enqueue(a);
    proxyGenerationService.enqueue(b);
    await vi.waitFor(() => expect(generateProxyVideo).toHaveBeenCalledTimes(1));
    await runProjectClosingHooks();
    await proxyGenerationService.whenIdle();

    expect(a.commit).not.toHaveBeenCalled();
    expect(b.loadSource).not.toHaveBeenCalled();
  });
});

describe("needsProxy", () => {
  const video: Asset = {
    id: "v",
    name: "v.mp4",
    hash: "h",
    src: "v.mp4",
    type: "video",
    createdAt: 1,
  };

  it("wants a proxy for a video that has none", () => {
    expect(needsProxy(video)).toBe(true);
    expect(
      needsProxy({ ...video, creationMetadata: { source: "uploaded" } }),
    ).toBe(true);
  });

  it("skips non-video assets, loaded proxies and masks", () => {
    expect(needsProxy({ ...video, type: "image" })).toBe(false);
    expect(needsProxy({ ...video, proxyFile: new Blob(["proxy"]) })).toBe(false);
    expect(
      needsProxy({
        ...video,
        creationMetadata: {
          source: "brush_mask",
        } as Asset["creationMetadata"],
      }),
    ).toBe(false);
  });
});
