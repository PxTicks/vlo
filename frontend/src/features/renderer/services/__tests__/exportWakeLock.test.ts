import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireExportWakeLock } from "../exportWakeLock";

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function createSentinel(): FakeSentinel {
  const releaseListeners = new Set<() => void>();
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn(() => {
      sentinel.released = true;
      for (const listener of releaseListeners) {
        listener();
      }
      return Promise.resolve();
    }),
    addEventListener: vi.fn((_type: "release", listener: () => void) => {
      releaseListeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: "release", listener: () => void) => {
      releaseListeners.delete(listener);
    }),
  };
  return sentinel;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function installWakeLock(request: (type: "screen") => Promise<FakeSentinel>) {
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
}

function removeWakeLock() {
  Reflect.deleteProperty(navigator as object, "wakeLock");
}

beforeEach(() => {
  setVisibility("visible");
});

afterEach(() => {
  removeWakeLock();
  setVisibility("visible");
  vi.restoreAllMocks();
});

describe("acquireExportWakeLock", () => {
  it("returns an inert handle when the platform has no wake lock API", () => {
    removeWakeLock();

    const handle = acquireExportWakeLock();

    // Must not throw: an unsupported browser exports exactly as it does today.
    expect(() => handle.release()).not.toThrow();
  });

  it("requests a screen lock and releases it when the job ends", async () => {
    const sentinel = createSentinel();
    const request = vi.fn(async () => sentinel);
    installWakeLock(request);

    const handle = acquireExportWakeLock();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("screen");

    handle.release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("keeps release idempotent", async () => {
    const sentinel = createSentinel();
    installWakeLock(async () => sentinel);

    const handle = acquireExportWakeLock();
    await Promise.resolve();

    handle.release();
    handle.release();
    handle.release();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("never rejects when the request is denied", async () => {
    const request = vi.fn(() => Promise.reject(new Error("denied")));
    installWakeLock(request as unknown as () => Promise<FakeSentinel>);

    const handle = acquireExportWakeLock();
    await Promise.resolve();
    await Promise.resolve();

    expect(() => handle.release()).not.toThrow();
  });

  it("skips the guaranteed rejection while the document is hidden", () => {
    setVisibility("hidden");
    const request = vi.fn(async () => createSentinel());
    installWakeLock(request);

    acquireExportWakeLock();

    expect(request).not.toHaveBeenCalled();
  });

  it("re-acquires when the document becomes visible again", async () => {
    const request = vi.fn(async () => createSentinel());
    installWakeLock(request);

    const handle = acquireExportWakeLock();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    // The platform drops the lock on hide and does not restore it on return,
    // so the export would silently lose its assertion without re-acquisition.
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    handle.release();
  });

  it("releases a stale pending grant and keeps the replacement lock", async () => {
    const sentinels = [createSentinel(), createSentinel()];
    const resolveRequests: Array<(value: FakeSentinel) => void> = [];
    const request = vi.fn(
      () =>
        new Promise<FakeSentinel>((resolve) => {
          resolveRequests.push(resolve);
        }),
    );
    installWakeLock(request);

    const handle = acquireExportWakeLock();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(request).toHaveBeenCalledTimes(2);

    resolveRequests[0](sentinels[0]);
    resolveRequests[1](sentinels[1]);
    await Promise.resolve();
    await Promise.resolve();

    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(sentinels[1].release).not.toHaveBeenCalled();

    handle.release();
    expect(sentinels[1].release).toHaveBeenCalledTimes(1);
  });

  it("re-acquires when the platform releases a visible lock", async () => {
    const sentinels = [createSentinel(), createSentinel()];
    const request = vi
      .fn()
      .mockResolvedValueOnce(sentinels[0])
      .mockResolvedValueOnce(sentinels[1]);
    installWakeLock(request);

    const handle = acquireExportWakeLock();
    await Promise.resolve();

    await (sentinels[0].release as () => Promise<void>)();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);

    handle.release();
    expect(sentinels[1].release).toHaveBeenCalledTimes(1);
  });

  it("stops re-acquiring after release", async () => {
    const request = vi.fn(async () => createSentinel());
    installWakeLock(request);

    const handle = acquireExportWakeLock();
    await Promise.resolve();
    handle.release();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a lock granted after the caller already released", async () => {
    const sentinel = createSentinel();
    let resolveRequest: (value: FakeSentinel) => void = () => {};
    installWakeLock(
      () =>
        new Promise<FakeSentinel>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const handle = acquireExportWakeLock();
    handle.release();
    resolveRequest(sentinel);
    await Promise.resolve();
    await Promise.resolve();

    // A short export can finish before the grant lands; the late sentinel must
    // not leak an assertion that keeps the machine awake indefinitely.
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});
