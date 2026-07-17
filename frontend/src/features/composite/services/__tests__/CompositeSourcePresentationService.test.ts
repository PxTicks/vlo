import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishCompositeSourcePresentations,
  resetCompositeSourcePresentations,
  waitForCompositeSourcePresentation,
} from "../CompositeSourcePresentationService";

describe("CompositeSourcePresentationService", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetCompositeSourcePresentations();
  });

  it("resolves only after the requested baked revision is presented", async () => {
    const pending = waitForCompositeSourcePresentation({
      compositeId: "composite",
      revision: 2,
      assetId: "new-bake",
    });

    publishCompositeSourcePresentations([
      {
        epoch: 1,
        placementId: "placement",
        compositeId: "composite",
        revision: 1,
        mode: "baked",
        assetId: "old-bake",
      },
    ]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    publishCompositeSourcePresentations([
      {
        epoch: 2,
        placementId: "placement",
        compositeId: "composite",
        revision: 2,
        mode: "baked",
        assetId: "new-bake",
      },
    ]);
    await expect(pending).resolves.toBe(true);
  });

  it("times out safely instead of authorizing early retirement", async () => {
    vi.useFakeTimers();
    const pending = waitForCompositeSourcePresentation(
      {
        compositeId: "composite",
        revision: 2,
        assetId: "new-bake",
      },
      50,
    );

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(false);
  });
});
