import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecoderWorkerPool,
  resetSharedDecoderWorkerPoolForTests,
} from "../DecoderWorkerPool";
import {
  DECODER_WORKER_BOOT_TIMEOUT_MS,
  DECODER_WORKER_STARTUP_GRACE_MS,
  resetDecoderWorkerRecoveryForTests,
} from "../../utils/decoderWorkerRecovery";

const IDLE_WORKER_RECYCLE_MS = 5 * 60 * 1000;

interface MockWorkerPlan {
  autoBoot?: boolean;
  bootDelayMs?: number;
  respondToPing?: boolean;
}

interface MockWorkerInstance {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

const { mockWorkerInstances, mockWorkerPlans } = vi.hoisted(() => {
  const workerInstances: MockWorkerInstance[] = [];
  const workerPlans: MockWorkerPlan[] = [];

  return {
    mockWorkerInstances: workerInstances,
    mockWorkerPlans: workerPlans,
  };
});

vi.mock("@decoder-worker-loader", () => ({
  default: class MockWorker implements MockWorkerInstance {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly postMessage = vi.fn(
      (message: {
        clipId?: string;
        pingId?: string;
        type?: string;
      }) => {
        if (message.type === "ping" && this.plan.respondToPing !== false) {
          if (this.booted) {
            this.sendPong(message.pingId);
          } else if (typeof message.pingId === "string") {
            this.pendingPings.push(message.pingId);
          }
        }
      },
    );
    readonly terminate = vi.fn(() => {
      this.terminated = true;
    });

    private booted = false;
    private readonly pendingPings: string[] = [];
    private readonly plan: MockWorkerPlan;
    private terminated = false;

    constructor() {
      this.plan = mockWorkerPlans.shift() ?? {};
      mockWorkerInstances.push(this);

      if (this.plan.autoBoot !== false) {
        setTimeout(() => {
          if (this.terminated) {
            return;
          }
          this.booted = true;
          this.onmessage?.({
            data: {
              type: "worker-health",
              event: "boot",
            },
          } as MessageEvent);
          for (const pingId of this.pendingPings.splice(0)) {
            this.sendPong(pingId);
          }
        }, this.plan.bootDelayMs ?? 0);
      }
    }

    private sendPong(pingId: string | undefined): void {
      setTimeout(() => {
        if (this.terminated) {
          return;
        }
        this.onmessage?.({
          data: {
            type: "worker-health",
            event: "pong",
            pingId,
            detail: { rendererCount: 1 },
          },
        } as MessageEvent);
      }, 0);
    }
  },
}));

function getWorkerMessages(
  worker: MockWorkerInstance,
  type: string,
): Array<Record<string, unknown>> {
  return worker.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

describe("DecoderWorkerPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWorkerInstances.length = 0;
    mockWorkerPlans.length = 0;
    resetDecoderWorkerRecoveryForTests();
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
    const prepareMessages = getWorkerMessages(worker, "prepare");

    expect(prepareMessages).toHaveLength(2);
    expect(prepareMessages[0]?.clipId).not.toBe(prepareMessages[1]?.clipId);

    worker.onmessage?.({
      data: {
        type: "ready",
        clipId: prepareMessages[0]?.clipId,
        kind: "video",
      },
    } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "frame",
        clipId: prepareMessages[1]?.clipId,
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

  it("stagger-spawns warmup workers toward the target size", async () => {
    const pool = createDecoderWorkerPool({ label: "test", size: 3 });

    pool.warmUp();

    expect(mockWorkerInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(mockWorkerInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockWorkerInstances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockWorkerInstances).toHaveLength(3);

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
    await vi.advanceTimersByTimeAsync(10);

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
    mockWorkerPlans.push(
      { autoBoot: false, respondToPing: false },
      { autoBoot: true },
    );
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
    await vi.advanceTimersByTimeAsync(1);

    expect(await resolutionPromise).toBe("worker-replaced");
    expect(mockWorkerInstances).toHaveLength(2);
    expect(mockWorkerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(onSourceEvicted).toHaveBeenCalledWith("clip-1");

    lease.release();
    pool.dispose();
  });

  it("waits for a booted replacement before terminating an unbooted worker", async () => {
    mockWorkerPlans.push(
      { autoBoot: false, respondToPing: false },
      { autoBoot: true, bootDelayMs: 25 },
    );
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

    await vi.advanceTimersByTimeAsync(DECODER_WORKER_BOOT_TIMEOUT_MS);
    expect(mockWorkerInstances).toHaveLength(2);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockWorkerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(onSourceEvicted).toHaveBeenCalledWith("clip-1");

    lease.release();
    pool.dispose();
  });

  it("evicts idle prepared video sources above the global cap", async () => {
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

    for (let index = 1; index <= 16; index += 1) {
      lease.prepare({
        clipId: `clip-${index}`,
        url: `blob:${index}`,
        kind: "video",
      });
    }

    const worker = mockWorkerInstances[0];
    const initialPrepareMessages = getWorkerMessages(worker, "prepare");
    for (const message of initialPrepareMessages) {
      worker.onmessage?.({
        data: {
          type: "ready",
          clipId: message.clipId,
          kind: "video",
        },
      } as MessageEvent);
    }

    await vi.advanceTimersByTimeAsync(3100);

    lease.prepare({
      clipId: "clip-17",
      url: "blob:17",
      kind: "video",
    });
    const latestPrepareMessage = getWorkerMessages(worker, "prepare").at(-1);
    worker.onmessage?.({
      data: {
        type: "ready",
        clipId: latestPrepareMessage?.clipId,
        kind: "video",
      },
    } as MessageEvent);

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispose",
        clipId: initialPrepareMessages[0]?.clipId,
      }),
    );
    expect(onSourceEvicted).toHaveBeenCalledWith("clip-1");

    lease.release();
    pool.dispose();
  });

  it("recycles long-idle workers add-before-remove", async () => {
    mockWorkerPlans.push(
      { autoBoot: true },
      { autoBoot: true, bootDelayMs: 25 },
    );
    const pool = createDecoderWorkerPool({ label: "test", size: 1 });

    pool.warmUp();
    expect(mockWorkerInstances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(IDLE_WORKER_RECYCLE_MS);
    expect(mockWorkerInstances).toHaveLength(2);
    expect(mockWorkerInstances[0]?.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(mockWorkerInstances[0]?.terminate).toHaveBeenCalledTimes(1);

    pool.dispose();
  });
});
