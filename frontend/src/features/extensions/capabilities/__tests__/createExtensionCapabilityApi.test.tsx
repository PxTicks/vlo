import { render, screen, waitFor } from "@testing-library/react";
import type { FC } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeCapabilities,
  getRuntimeCapability,
  getRuntimeCapabilityProbe,
  startRuntimeCapabilityProbe,
} from "../../../../services/runtimeApi";
import type { RuntimeCapability } from "../../../../types/RuntimeStatus";
import { useRuntimeCapabilityStore } from "../../../runtimeCapabilities";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { createExtensionCapabilityApi } from "../createExtensionCapabilityApi";

vi.mock("../../../../services/runtimeApi", () => ({
  getRuntimeCapabilities: vi.fn(),
  getRuntimeCapability: vi.fn(),
  getRuntimeCapabilityProbe: vi.fn(),
  startRuntimeCapabilityProbe: vi.fn(),
  downloadRuntimeDiagnostics: vi.fn(),
}));

const OWNER = "acme.tracking";
const TRACKER = `${OWNER}:tracker`;

function scopeFor(
  extensionId = OWNER,
  signal: AbortSignal = new AbortController().signal,
): ExtensionApiScope & { resources: ExtensionResource[] } {
  const resources: ExtensionResource[] = [];
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
    resources,
  };
}

function capability(overrides: Partial<RuntimeCapability> = {}): RuntimeCapability {
  return {
    id: TRACKER,
    label: "Acme Tracker",
    state: "available_unverified",
    canAttempt: true,
    verifiedThrough: "environment",
    checkedAt: "2026-08-26T12:00:00Z",
    selectedModel: "acme-tracker-base",
    device: null,
    models: [],
    checks: [],
    lastFailure: null,
    ...overrides,
  };
}

const blocked = capability({
  state: "blocked",
  canAttempt: false,
  verifiedThrough: "discovered",
  checks: [
    {
      id: "package.acme_tracker",
      status: "fail",
      stage: "environment",
      summary: "acme-tracker is not installed",
      code: "package_missing",
      remediation: {
        kind: "command",
        summary: "Install the Acme tracker runtime",
        command: "uv pip install acme-tracker",
        requiresRestart: true,
      },
    },
  ],
});

const hostCapability = capability({
  id: "sam2",
  label: "SAM2",
  selectedModel: "sam2.1_hiera_large",
});

function payload(...capabilities: RuntimeCapability[]) {
  return { capabilities, environment: null as never };
}

function singlePayload(value: RuntimeCapability) {
  return { capability: value, environment: null as never };
}

describe("createExtensionCapabilityApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeCapabilityStore.getState().reset();
    vi.mocked(getRuntimeCapabilities).mockResolvedValue(
      payload(capability(), hostCapability),
    );
  });

  afterEach(() => {
    useRuntimeCapabilityStore.getState().reset();
  });

  describe("scope", () => {
    it("lists only the calling extension's own capabilities", async () => {
      vi.mocked(getRuntimeCapabilities).mockResolvedValue(
        payload(
          capability(),
          hostCapability,
          capability({ id: "other.vendor:tracker", label: "Someone else's" }),
        ),
      );
      const api = createExtensionCapabilityApi(scopeFor());

      await api.ensureLoaded();

      expect(api.list().map((entry) => entry.id)).toEqual([TRACKER]);
    });

    it("addresses an own capability by local name or namespaced id", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();

      expect(api.get("tracker")?.id).toBe(TRACKER);
      expect(api.get(TRACKER)?.id).toBe(TRACKER);
      expect(api.read("tracker").id).toBe(TRACKER);
    });

    it("reads a host capability through the host accessors", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();

      expect(api.getHost("sam2")?.label).toBe("SAM2");
      expect(api.readHost("sam2").canAttempt).toBe(true);
      // Read-only by construction: there is no host recheck or host test.
      expect(api.readHost("beat-this").capability).toBeNull();
      expect(() => api.getHost(TRACKER)).toThrow(/not a host one/);
    });

    it("keeps a bare name the caller's own, even one a host capability shares", async () => {
      // The backend registrar deliberately allows a local id of "sam2" and
      // namespaces it, so a bare name must never resolve to the host's — and a
      // host capability added in a later release must not retarget an id an
      // extension is already using.
      vi.mocked(getRuntimeCapabilities).mockResolvedValue(
        payload(
          hostCapability,
          capability({ id: `${OWNER}:sam2`, label: "Acme's own sam2" }),
        ),
      );
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();

      expect(api.get("sam2")?.label).toBe("Acme's own sam2");
      expect(api.getHost("sam2")?.label).toBe("SAM2");
    });

    it("refuses another extension's capability outright", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();

      expect(() => api.get("other.vendor:tracker")).toThrow(/does not belong to/);
      expect(() => api.read("other.vendor:tracker")).toThrow(/does not belong to/);
      await expect(api.recheck("other.vendor:tracker")).rejects.toThrow(
        /does not belong to/,
      );
    });

    it("rejects a malformed capability name rather than reading nothing", () => {
      const api = createExtensionCapabilityApi(scopeFor());

      expect(() => api.get("Tracker_2")).toThrow(TypeError);
      expect(() => api.get("")).toThrow(/non-empty string/);
    });
  });

  describe("reads", () => {
    it("says it is still checking rather than unavailable before the first read", () => {
      const api = createExtensionCapabilityApi(scopeFor());

      const view = api.read("tracker");

      expect(view.capability).toBeNull();
      expect(view.checking).toBe(true);
      // Unknown is not available, but it is also not a failure to explain.
      expect(view.canAttempt).toBe(false);
      expect(view.failureCode).toBeNull();
      expect(api.getStatus()).toBe("idle");
    });

    it("projects the blocking check the way the host's own surfaces do", async () => {
      vi.mocked(getRuntimeCapabilities).mockResolvedValue(payload(blocked));
      const api = createExtensionCapabilityApi(scopeFor());

      await api.ensureLoaded();
      const view = api.read("tracker");

      expect(view.canAttempt).toBe(false);
      expect(view.failureCode).toBe("package_missing");
      expect(view.message).toBe("acme-tracker is not installed");
      expect(view.failure?.remediation?.command).toBe(
        "uv pip install acme-tracker",
      );
    });

    it("hands out snapshots the extension cannot mutate the host through", async () => {
      // Trusted code can reach the store directly; this is about accidents.
      // A shared reference would let a panel edit what Runtime Diagnostics
      // reports, with no store update to make the change visible.
      vi.mocked(getRuntimeCapabilities).mockResolvedValue(payload(blocked));
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();

      const snapshot = api.get("tracker");
      const check = snapshot?.checks[0];
      expect(() => {
        (check as { summary: string }).summary = "tampered";
      }).toThrow(TypeError);
      expect(api.read("tracker").failure).not.toBe(check);

      const stored = useRuntimeCapabilityStore.getState().capabilities[TRACKER];
      expect(stored?.checks[0]).not.toBe(check);
      expect(stored?.checks[0]?.summary).toBe("acme-tracker is not installed");
    });

    it("joins the host's single-flight read instead of opening a second one", async () => {
      const api = createExtensionCapabilityApi(scopeFor());

      await Promise.all([
        api.ensureLoaded(),
        api.ensureLoaded(),
        useRuntimeCapabilityStore.getState().ensureLoaded(),
      ]);

      expect(getRuntimeCapabilities).toHaveBeenCalledTimes(1);
      expect(api.getStatus()).toBe("ready");
    });
  });

  describe("subscriptions", () => {
    it("signals when a capability's reported state changes", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      const listener = vi.fn();
      api.subscribe(listener);
      const before = api.getRevision();

      await api.ensureLoaded();

      expect(listener).toHaveBeenCalled();
      expect(api.getRevision()).toBeGreaterThan(before);
    });

    it("stops at deactivation, through the owning scope", async () => {
      const scope = scopeFor();
      const api = createExtensionCapabilityApi(scope);
      const listener = vi.fn();
      api.subscribe(listener);

      await Promise.all(
        scope.resources.map((resource) =>
          typeof resource === "function" ? resource() : resource.dispose(),
        ),
      );
      await api.ensureLoaded();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("writes", () => {
    it("rechecks through the host store and returns the fresh view", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();
      vi.mocked(getRuntimeCapability).mockResolvedValue(singlePayload(blocked));

      const result = await api.recheck("tracker");

      expect(getRuntimeCapability).toHaveBeenCalledWith(TRACKER, {
        refresh: true,
      });
      expect(result.ok).toBe(true);
      expect(result.view.canAttempt).toBe(false);
      expect(result.view.failureCode).toBe("package_missing");
      expect(result.view.rechecking).toBe(false);
    });

    it("reports a failed recheck instead of returning the stale healthy view", async () => {
      // The store keeps the previous snapshot when a recheck fails, so a view
      // alone would say "available" about a reading nobody could refresh.
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();
      vi.mocked(getRuntimeCapability).mockRejectedValue(
        new Error("Backend unreachable"),
      );

      const result = await api.recheck("tracker");

      expect(result).toMatchObject({
        ok: false,
        status: "failed",
        error: "Backend unreachable",
      });
      // The last good reading is still there, and still says so.
      expect(result.view.canAttempt).toBe(true);
    });

    it("joins a recheck already running rather than starting a second", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();
      vi.mocked(getRuntimeCapability).mockResolvedValue(singlePayload(blocked));

      const [first, second] = await Promise.all([
        api.recheck("tracker"),
        api.recheck(TRACKER),
      ]);

      expect(getRuntimeCapability).toHaveBeenCalledTimes(1);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.view.failureCode).toBe("package_missing");
    });

    it("reports verifiedThrough 'loaded' after a successful runtime test", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      await api.ensureLoaded();
      vi.mocked(startRuntimeCapabilityProbe).mockResolvedValue({
        jobId: "probe-1",
      });
      vi.mocked(getRuntimeCapabilityProbe).mockResolvedValue({
        jobId: "probe-1",
        jobType: "load-runtime",
        status: "succeeded",
        progress: 1,
        message: "Succeeded",
        result: { capabilityId: TRACKER, loaded: true, details: {} },
      });
      vi.mocked(getRuntimeCapability).mockResolvedValue(
        singlePayload(capability({ state: "ready", verifiedThrough: "loaded" })),
      );

      const result = await api.test("tracker");

      expect(startRuntimeCapabilityProbe).toHaveBeenCalledWith(
        TRACKER,
        expect.anything(),
      );
      expect(result.ok).toBe(true);
      expect(result.view.verifiedThrough).toBe("loaded");
      expect(result.view.canAttempt).toBe(true);
      expect(result.view.testing).toBe(false);
    });

    it("stops following a running load test when the extension deactivates", async () => {
      // A probe polls for up to twenty minutes. A disabled extension must not
      // keep that loop alive — and cancelling it must not touch the host's own
      // tests, which is all the store's global cancelTests could offer.
      const controller = new AbortController();
      const scope = scopeFor(OWNER, controller.signal);
      const api = createExtensionCapabilityApi(scope);
      await api.ensureLoaded();
      vi.mocked(startRuntimeCapabilityProbe).mockResolvedValue({
        jobId: "probe-1",
      });
      vi.mocked(getRuntimeCapabilityProbe).mockResolvedValue({
        jobId: "probe-1",
        jobType: "load-runtime",
        status: "running",
        progress: 0.5,
        message: "Loading",
      });
      useRuntimeCapabilityStore
        .getState()
        .testCapability("sam2")
        .catch(() => undefined);

      const running = api.test("tracker");
      await waitFor(() =>
        expect(useRuntimeCapabilityStore.getState().testing).toContain(TRACKER),
      );
      controller.abort();
      await Promise.all(
        scope.resources.map((resource) =>
          typeof resource === "function" ? resource() : resource.dispose(),
        ),
      );

      await expect(running).resolves.toMatchObject({
        ok: false,
        status: "cancelled",
      });
      expect(useRuntimeCapabilityStore.getState().testing).not.toContain(TRACKER);
      // The host's own test is untouched.
      expect(useRuntimeCapabilityStore.getState().testing).toContain("sam2");
      useRuntimeCapabilityStore.getState().cancelTests();
    });

    it("refuses a write after deactivation", async () => {
      const controller = new AbortController();
      const api = createExtensionCapabilityApi(scopeFor(OWNER, controller.signal));
      await api.ensureLoaded();
      controller.abort();

      await expect(api.recheck("tracker")).rejects.toThrow(/after deactivation/);
      await expect(api.test("tracker")).rejects.toThrow(/after deactivation/);
      expect(getRuntimeCapability).not.toHaveBeenCalled();
    });
  });

  describe("FailureNotice", () => {
    it("renders the host's remediation, command and all", async () => {
      vi.mocked(getRuntimeCapabilities).mockResolvedValue(payload(blocked));
      const api = createExtensionCapabilityApi(scopeFor());
      const Notice = api.FailureNotice as FC<{ capabilityId: string }>;

      render(<Notice capabilityId="tracker" />);

      await waitFor(() => {
        expect(screen.getByTestId("capability-failure-alert")).toHaveAttribute(
          "data-failure-code",
          "package_missing",
        );
      });
      expect(
        screen.getByText("Acme Tracker unavailable: Python package not installed"),
      ).toBeInTheDocument();
      expect(screen.getByText("uv pip install acme-tracker")).toBeInTheDocument();
    });

    it("renders nothing while the capability is healthy", async () => {
      const api = createExtensionCapabilityApi(scopeFor());
      const Notice = api.FailureNotice as FC<{ capabilityId: string }>;

      const { container } = render(<Notice capabilityId="tracker" />);

      await waitFor(() => expect(api.getStatus()).toBe("ready"));
      expect(container).toBeEmptyDOMElement();
    });
  });
});
