import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostNotificationCenter } from "../../../../core/shell/notificationCenter";
import {
  createExtensionNotificationApi,
  MAX_LIVE_NOTIFICATIONS_PER_EXTENSION,
} from "../createExtensionNotificationApi";

function createScope(extensionId = "example.a") {
  const controller = new AbortController();
  const resources: ExtensionResource[] = [];
  const report = vi.fn();
  const scope: ExtensionApiScope = {
    extension: { id: extensionId, version: "1.0.0" },
    signal: controller.signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report,
  };
  return {
    scope,
    report,
    controller,
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
    resourceCount: () => resources.length,
  };
}

describe("createExtensionNotificationApi", () => {
  let center: HostNotificationCenter;

  beforeEach(() => {
    vi.useFakeTimers();
    center = new HostNotificationCenter(() => 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attributes entries to the owning extension", () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);

    api.toast({ message: "Done", tone: "success" });
    const task = api.task({ title: "Working", progress: 0.25 });

    expect(center.listByOwner("example.a")).toHaveLength(2);
    expect(center.list().every((entry) => entry.source === "extension")).toBe(true);
    expect(center.list().find((entry) => entry.id === task.id)).toMatchObject({
      kind: "task",
      progress: 0.25,
      ownerId: "example.a",
    });
  });

  it("registers exactly one cleanup however many entries it posts", () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    expect(harness.resourceCount()).toBe(0);
    api.toast({ message: "one", durationMs: 0 });
    api.toast({ message: "two", durationMs: 0 });
    api.task({ title: "three" });
    expect(harness.resourceCount()).toBe(1);
  });

  it("removes everything it posted when the extension deactivates", async () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    center.postToast({ message: "host toast", durationMs: 0 });
    api.toast({ message: "extension toast", durationMs: 0 });
    api.task({ title: "half-finished work" });

    await harness.dispose();
    // A package that dies mid-task must not leave a spinner behind, and must
    // not take the host's own entries with it either.
    expect(center.listByOwner("example.a")).toEqual([]);
    expect(center.list()).toHaveLength(1);
  });

  it("ignores a retained task handle after deactivation", async () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    const task = api.task({ title: "half-finished work" });

    harness.controller.abort();
    await harness.dispose();
    task.settle({ message: "late completion" });

    expect(center.list()).toEqual([]);
  });

  it("refuses to post after deactivation", async () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    harness.controller.abort();
    await harness.dispose();

    expect(() => api.toast({ message: "late" })).toThrow(/no longer post/);
    expect(() => api.task({ title: "late" })).toThrow(/no longer post/);
  });

  it("caps concurrent live entries, freeing slots as toasts expire", () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    for (let index = 0; index < MAX_LIVE_NOTIFICATIONS_PER_EXTENSION; index += 1) {
      api.toast({ message: `toast ${index}` });
    }
    expect(() => api.toast({ message: "one too many" })).toThrow(/at most/);

    vi.advanceTimersByTime(60_000);
    expect(() => api.toast({ message: "after expiry" })).not.toThrow();
  });

  it("isolates a throwing cancel handler onto the owning scope", () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    const task = api.task({
      title: "Cancellable",
      onCancel: () => {
        throw new Error("boom");
      },
    });

    expect(center.cancel(task.id)).toBe(true);
    expect(harness.report).toHaveBeenCalledWith(
      "error",
      "Task cancel handler failed.",
      expect.any(Error),
    );
    // The entry survives a failed cancel: only the work can settle it.
    expect(center.list()).toHaveLength(1);
    task.settle();
  });

  it("passes host validation failures through untouched", () => {
    const harness = createScope();
    const api = createExtensionNotificationApi(harness.scope, center);
    expect(() => api.toast({ message: "" })).toThrow(/non-empty/);
    expect(() => api.task({ title: "x", progress: Number.NaN })).toThrow(/finite/);
    expect(() =>
      api.task({ title: "x", onCancel: 3 as unknown as () => void }),
    ).toThrow(TypeError);
  });
});
