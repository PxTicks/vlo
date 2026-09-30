import { describe, expect, it, vi } from "vitest";
import { AdjustmentEffectResolver } from "../AdjustmentEffectResolver";

describe("AdjustmentEffectResolver.subscribeToSource", () => {
  it("notifies after the source is replaced, with the lookup already invalidated", () => {
    const resolver = new AdjustmentEffectResolver();
    const staleLookup = resolver.getPresentationLookup();
    const seen: unknown[] = [];
    const unsubscribe = resolver.subscribeToSource(() =>
      seen.push(resolver.getPresentationLookup()),
    );

    resolver.setAdjustmentSource([], [], 30);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(staleLookup);

    unsubscribe();
    const listener = vi.fn();
    resolver.subscribeToSource(listener)();
    resolver.setAdjustmentSource([], [], 30);
    expect(seen).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
