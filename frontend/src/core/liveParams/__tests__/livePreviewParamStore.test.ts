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

  it("holds JSON curve arrays as transient render overrides", () => {
    const curve = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ];
    livePreviewParamStore.set("grade-1", "curveMaster", curve);
    expect(
      livePreviewParamStore.get<typeof curve>("grade-1", "curveMaster"),
    ).toEqual(curve);
    livePreviewParamStore.clear("grade-1", "curveMaster");
    expect(
      livePreviewParamStore.get<typeof curve>("grade-1", "curveMaster"),
    ).toBeUndefined();
  });
});
