import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
} from "../../../services/runtimeApi";
import type { RuntimeCapability } from "../../../types/RuntimeStatus";
import { blockingCheck, failureHeadline, isModelProblem } from "../failureCodes";
import { useRuntimeCapabilityStore } from "../useRuntimeCapabilityStore";

vi.mock("../../../services/runtimeApi", () => ({
  getRuntimeCapabilities: vi.fn(),
  getRuntimeCapability: vi.fn(),
}));

function capability(overrides: Partial<RuntimeCapability> = {}): RuntimeCapability {
  return {
    id: "sam-audio",
    label: "SAM-Audio",
    state: "available_unverified",
    canAttempt: true,
    verifiedThrough: "environment",
    checkedAt: "2026-08-25T12:00:00Z",
    selectedModel: "sam-audio-large-tv",
    device: null,
    models: [],
    checks: [],
    lastFailure: null,
    ...overrides,
  };
}

function payload(...capabilities: RuntimeCapability[]) {
  return { capabilities, environment: null as never };
}

function singlePayload(capability: RuntimeCapability) {
  return { capability, environment: null as never };
}

describe("useRuntimeCapabilityStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeCapabilityStore.getState().reset();
  });

  afterEach(() => {
    useRuntimeCapabilityStore.getState().reset();
  });

  it("fetches once and indexes capabilities by id", async () => {
    vi.mocked(getRuntimeCapabilities).mockResolvedValue(payload(capability()));

    await useRuntimeCapabilityStore.getState().ensureLoaded();
    await useRuntimeCapabilityStore.getState().ensureLoaded();

    expect(getRuntimeCapabilities).toHaveBeenCalledTimes(1);
    expect(getRuntimeCapabilities).toHaveBeenCalledWith({ refresh: false });
    const state = useRuntimeCapabilityStore.getState();
    expect(state.status).toBe("ready");
    expect(state.capabilities["sam-audio"]?.canAttempt).toBe(true);
  });

  it("joins a request already in flight instead of starting another", async () => {
    // A cold read runs out-of-process probes for several seconds; four
    // surfaces mounting at once must not each pay for one.
    let resolvePayload: (value: unknown) => void = () => {};
    vi.mocked(getRuntimeCapabilities).mockReturnValue(
      new Promise((resolve) => {
        resolvePayload = resolve;
      }) as never,
    );

    const first = useRuntimeCapabilityStore.getState().ensureLoaded();
    const second = useRuntimeCapabilityStore.getState().ensureLoaded();
    expect(useRuntimeCapabilityStore.getState().status).toBe("checking");

    resolvePayload(payload(capability()));
    await Promise.all([first, second]);

    expect(getRuntimeCapabilities).toHaveBeenCalledTimes(1);
  });

  it("refreshes past the cached answer when asked", async () => {
    vi.mocked(getRuntimeCapabilities).mockResolvedValue(payload(capability()));
    await useRuntimeCapabilityStore.getState().ensureLoaded();

    await useRuntimeCapabilityStore.getState().refreshAll();

    expect(getRuntimeCapabilities).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("rechecks one capability without dropping the others", async () => {
    vi.mocked(getRuntimeCapabilities).mockResolvedValue(
      payload(capability(), capability({ id: "sam2", label: "SAM2" })),
    );
    await useRuntimeCapabilityStore.getState().ensureLoaded();

    vi.mocked(getRuntimeCapability).mockResolvedValue(
      singlePayload(
        capability({
          state: "ready",
          canAttempt: true,
          verifiedThrough: "loaded",
        }),
      ),
    );
    await useRuntimeCapabilityStore.getState().refreshCapability("sam-audio");

    const state = useRuntimeCapabilityStore.getState();
    expect(getRuntimeCapability).toHaveBeenCalledWith("sam-audio", {
      refresh: true,
    });
    expect(state.capabilities["sam-audio"]?.state).toBe("ready");
    expect(state.capabilities.sam2).toBeDefined();
    expect(state.refreshing).toEqual([]);
  });

  it("takes the environment that came back with a recheck", async () => {
    // A recheck drops the shared torch/device probe on the backend too, so
    // pairing the new capability with the environment from before it would
    // show a freshly checked feature beside stale device information.
    vi.mocked(getRuntimeCapabilities).mockResolvedValue({
      capabilities: [capability()],
      environment: { checkedAt: "12:00" } as never,
    });
    await useRuntimeCapabilityStore.getState().ensureLoaded();

    vi.mocked(getRuntimeCapability).mockResolvedValue({
      capability: capability({ state: "ready" }),
      environment: { checkedAt: "12:05" } as never,
    });
    await useRuntimeCapabilityStore.getState().refreshCapability("sam-audio");

    expect(useRuntimeCapabilityStore.getState().environment).toEqual({
      checkedAt: "12:05",
    });
  });

  it("serialises a full refresh against a per-capability recheck", async () => {
    // Both invalidate the same backend probe cache. Overlapping them would
    // have each re-run the other's probes and land in whichever order they
    // happened to finish.
    const order: string[] = [];
    let releaseList: () => void = () => {};
    vi.mocked(getRuntimeCapabilities).mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("list:start");
          releaseList = () => {
            order.push("list:end");
            resolve(payload(capability()));
          };
        }) as never,
    );
    vi.mocked(getRuntimeCapability).mockImplementation(async () => {
      order.push("one:start");
      return singlePayload(capability());
    });

    const listPromise = useRuntimeCapabilityStore.getState().refreshAll();
    const onePromise = useRuntimeCapabilityStore
      .getState()
      .refreshCapability("sam-audio");

    // The queue schedules on a microtask, so let it start before asserting
    // that the second request has *not*.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["list:start"]);

    releaseList();
    await Promise.all([listPromise, onePromise]);

    expect(order).toEqual(["list:start", "list:end", "one:start"]);
  });

  it("records a fetch failure without claiming anything is available", async () => {
    vi.mocked(getRuntimeCapabilities).mockRejectedValue(new Error("offline"));

    await useRuntimeCapabilityStore.getState().ensureLoaded();

    const state = useRuntimeCapabilityStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("offline");
    expect(state.capabilities).toEqual({});
  });
});

describe("failure codes", () => {
  it("treats only model problems as downloadable", () => {
    expect(isModelProblem("model_missing")).toBe(true);
    expect(isModelProblem("model_invalid")).toBe(true);
    // The whole point: a missing package is not a download away.
    expect(isModelProblem("package_missing")).toBe(false);
    expect(isModelProblem("package_import_failed")).toBe(false);
    expect(isModelProblem(null)).toBe(false);
  });

  it("names every code", () => {
    expect(failureHeadline("package_missing")).toBe(
      "Python package not installed",
    );
    expect(failureHeadline("device_unavailable")).toBe(
      "Requested device unavailable",
    );
    expect(failureHeadline(null)).toBe("Unavailable");
  });

  it("picks the first failing check as the explanation", () => {
    const blocked = capability({
      canAttempt: false,
      checks: [
        {
          id: "model.default",
          status: "pass",
          stage: "discovered",
          summary: "checkpoint found",
        },
        {
          id: "package.sam_audio",
          status: "fail",
          stage: "environment",
          code: "package_missing",
          summary: "The sam_audio package is not installed",
        },
      ],
    });

    expect(blockingCheck(blocked)?.code).toBe("package_missing");
    expect(blockingCheck(null)).toBeNull();
  });
});
