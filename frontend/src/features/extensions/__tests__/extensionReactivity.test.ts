import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../types";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import { createExtensionAssetApi } from "../assets/createExtensionAssetApi";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useAssetStore } from "../../userAssets";
import type { Asset } from "../../../types/Asset";

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): { scope: ExtensionApiScope; resources: ExtensionResource[] } {
  const resources: ExtensionResource[] = [];
  return {
    resources,
    scope: {
      extension: { id: extensionId, version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report,
    },
  };
}

describe("extension timeline reactivity", () => {
  it("signals committed model changes but not selection-only updates", () => {
    useTimelineStore.setState({ clips: [], tracks: [], selectedClipIds: [] });
    const { scope } = createScope("example.reactive");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const initial = api.getRevision();

    useTimelineStore.setState({ selectedClipIds: ["c1"] });
    expect(listener).not.toHaveBeenCalled();
    expect(api.getRevision()).toBe(initial);

    useTimelineStore.setState({ tracks: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    unsubscribe();

    useTimelineStore.setState({ clips: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates listener failures with an owner diagnostic and keeps notifying", () => {
    const report = vi.fn();
    const { scope } = createScope("example.reactive-boom", report);
    const api = createExtensionTimelineApi(scope);
    const unsubscribe = api.subscribe(() => {
      throw new Error("listener boom");
    });

    useTimelineStore.setState({ tracks: [] });
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Timeline subscriber failed"),
      expect.any(Error),
    );

    // Not unsubscribed by the failure: it reports again on the next commit.
    useTimelineStore.setState({ clips: [] });
    expect(report).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("enrolls subscriptions for owner-scope disposal", () => {
    const { scope, resources } = createScope("example.reactive-dispose");
    const api = createExtensionTimelineApi(scope);
    const listener = vi.fn();
    api.subscribe(listener);

    for (const resource of resources) {
      if (typeof resource === "function") void resource();
      else void resource.dispose();
    }
    useTimelineStore.setState({ tracks: [] });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("extension asset reactivity", () => {
  it("signals library changes and exposes a matching revision", () => {
    useAssetStore.setState({ assets: [] });
    const { scope } = createScope("example.assets");
    const api = createExtensionAssetApi(scope);
    const listener = vi.fn();
    api.subscribe(listener);
    const initial = api.getRevision();

    const asset = {
      id: "asset-1",
      hash: "hash-1",
      name: "clip.mp4",
      type: "video",
      src: "clip.mp4",
    } as Asset;
    useAssetStore.setState({ assets: [asset] });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRevision()).toBe(initial + 1);
    expect(api.list().map((snapshot) => snapshot.id)).toEqual(["asset-1"]);
  });
});
