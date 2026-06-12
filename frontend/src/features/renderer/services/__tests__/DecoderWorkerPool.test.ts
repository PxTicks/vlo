import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecoderWorkerPool,
  resetSharedDecoderWorkerPoolForTests,
} from "../DecoderWorkerPool";
import { DECODER_WORKER_STARTUP_GRACE_MS } from "../../utils/decoderWorkerRecovery";

const { mockWorkerInstances, mockWorkerPlans } = vi.hoisted(() => {
  const workerInstances: Array<{
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const workerPlans: Array<{ respondToPing?: boolean }> = [];

  return {
    mockWorkerInstances: workerInstances,
    mockWorkerPlans: workerPlans,
  };
});

vi.mock("../../workers/decoder.worker?worker", () => ({
  default: class MockWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly postMessage = vi.fn(
      (message: {
        type?: string;
        pingId?: string;
      }) => {
        if (message.type === "ping" && this.plan.respondToPing !== false) {
          setTimeout(() => {
            this.onmessage?.({
              data: {
                type: "worker-health",
                event: "pong",
                pingId: message.pingId,
                detail: { rendererCount: 1 },
              },
            } as MessageEvent);
          }, 0);
        }
      },
    );
    readonly terminate = vi.fn();
    private readonly plan: { respondToPing?: boolean };

    constructor() {
      this.plan = mockWorkerPlans.shift() ?? {};
      mockWorkerInstances.push(this);
    }
  },
}));

describe("DecoderWorkerPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkerInstances.length = 0;
    mockWorkerPlans.length = 0;
    resetSharedDecoderWorkerPoolForTests();
  });

  it("routes namespaced clipIds back to the owning lease without crosstalk", () => {
    const pool = createDecoderWorkerPool({ label: "test", size: 1 });
    const leaseAReady = vi.fn();
    const leaseAFrame = vi.fn();
    const leaseBReady = vi.fn();
    const leaseBFrame = vi.fn();

    const leaseA = pool.acquireLease(
      { label: "lease-a" },
      {
        onReady: leaseAReady,
        onFrame: leaseAFrame,
        onWorkerError: vi.fn(),
        onSourceEvicted: vi.fn(),
      },
    );
    const leaseB = pool.acquireLease(
      { label: "lease-b" },
      {
        onReady: leaseBReady,
        onFrame: leaseBFrame,
        onWorkerError: vi.fn(),
        onSourceEvicted: vi.fn(),
      },
    );

    leaseA.prepare({
      clipId: "clip-1",
      url: "blob:a",
      kind: "video",
    });
    leaseB.prepare({
      clipId: "clip-1",
      url: "blob:b",
      kind: "video",
    });

    const worker = mockWorkerInstances[0];
    const prepareMessages = worker.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "prepare");

    expect(prepareMessages).toHaveLength(2);
    expect(prepareMessages[0].clipId).not.toBe(prepareMessages[1].clipId);

    worker.onmessage?.({
      data: {
        type: "ready",
        clipId: prepareMessages[0].clipId,
        kind: "video",
      },
    } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "frame",
        clipId: prepareMessages[1].clipId,
        time: 1,
        bitmap: null,
      },
    } as MessageEvent);

    expect(leaseAReady).toHaveBeenCalledWith("clip-1", "video");
    expect(leaseBReady).not.toHaveBeenCalled();
    expect(leaseBFrame).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: "clip-1", time: 1 }),
    );
    expect(leaseAFrame).not.toHaveBeenCalled();

    leaseA.release();
    leaseB.release();
    pool.dispose();
  });

  it("does a renderer reset on pong without replacing the worker", async () => {
    const pool = createDecoderWorkerPool({ label: "test", size: 1 });
    const lease = pool.acquireLease(
      { label: "lease-a" },
      {
        onReady: vi.fn(),
        onFrame: vi.fn(),
        onWorkerError: vi.fn(),
        onSourceEvicted: vi.fn(),
      },
    );

    lease.prepare({
      clipId: "clip-1",
      url: "blob:a",
      kind: "video",
    });

    const resolutionPromise = lease.reportStall("clip-1", "test timeout");
    await vi.runAllTimersAsync();

    expect(await resolutionPromise).toBe("renderer-reset");
    expect(mockWorkerInstances).toHaveLength(1);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();
    expect(mockWorkerInstances[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispose",
        clipId: expect.stringMatching(/\/clip-1$/),
      }),
    );

    lease.release();
    pool.dispose();
  });

  it("replaces an unresponsive worker after startup grace and evicts its sources", async () => {
    mockWorkerPlans.push({ respondToPing: false }, { respondToPing: true });
    const pool = createDecoderWorkerPool({ label: "test", size: 1 });
    const onSourceEvicted = vi.fn();
    const lease = pool.acquireLease(
      { label: "lease-a" },
      {
        onReady: vi.fn(),
        onFrame: vi.fn(),
        onWorkerError: vi.fn(),
        onSourceEvicted,
      },
    );

    lease.prepare({
      clipId: "clip-1",
      url: "blob:a",
      kind: "video",
    });

    await vi.advanceTimersByTimeAsync(DECODER_WORKER_STARTUP_GRACE_MS + 20);
    const resolutionPromise = lease.reportStall("clip-1", "stalled worker");
    await vi.advanceTimersByTimeAsync(1200);
    await vi.runAllTimersAsync();

    expect(await resolutionPromise).toBe("worker-replaced");
    expect(mockWorkerInstances).toHaveLength(2);
    expect(mockWorkerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(onSourceEvicted).toHaveBeenCalledWith("clip-1");

    lease.release();
    pool.dispose();
  });
});
