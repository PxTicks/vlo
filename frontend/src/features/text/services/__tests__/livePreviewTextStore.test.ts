import { beforeEach, describe, expect, it, vi } from "vitest";
import { livePreviewTextStore } from "../livePreviewTextStore";

describe("livePreviewTextStore", () => {
  beforeEach(() => {
    livePreviewTextStore.clearAll();
  });

  it("stores and merges preview text updates by clip id", () => {
    livePreviewTextStore.set("clip_1", { content: "Draft" });
    livePreviewTextStore.set("clip_1", { fill: "#ff5500" });

    expect(livePreviewTextStore.get("clip_1")).toEqual({
      content: "Draft",
      fill: "#ff5500",
    });
  });

  it("can clear individual preview fields without dropping the rest", () => {
    livePreviewTextStore.set("clip_1", {
      content: "Draft",
      fill: "#ff5500",
    });

    livePreviewTextStore.clear("clip_1", ["content"]);

    expect(livePreviewTextStore.get("clip_1")).toEqual({
      fill: "#ff5500",
    });
  });

  it("notifies subscribers only when preview state changes", () => {
    const listener = vi.fn();
    const unsubscribe = livePreviewTextStore.subscribe(listener);

    livePreviewTextStore.set("clip_1", { content: "Draft" });
    livePreviewTextStore.set("clip_1", { content: "Draft" });
    livePreviewTextStore.clear("clip_1", ["content"]);

    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
