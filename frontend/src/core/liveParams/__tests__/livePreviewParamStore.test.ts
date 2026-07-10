import { beforeEach, describe, expect, it, vi } from "vitest";
import { livePreviewParamStore } from "../livePreviewParamStore";

describe("livePreviewParamStore", () => {
  beforeEach(() => {
    livePreviewParamStore.clearAll();
  });

  it("publishes a multi-parameter mask layout as one preview change", () => {
    const listener = vi.fn();
    const unsubscribe = livePreviewParamStore.subscribe(listener);

    livePreviewParamStore.setMany([
      { transformId: "position-1", paramName: "x", value: 120 },
      { transformId: "position-1", paramName: "y", value: 80 },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: "set",
      parameters: [
        { transformId: "position-1", paramName: "x" },
        { transformId: "position-1", paramName: "y" },
      ],
    });
    unsubscribe();
  });
});
