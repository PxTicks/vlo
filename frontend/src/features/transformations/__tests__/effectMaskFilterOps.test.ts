import { describe, it, expect } from "vitest";
import { buildResolvedFilterOpLookup } from "../effectMaskFilterOps";
import type { ApplyTransformStackContext } from "../applyTransformations";
import type { ClipTransform } from "../../../types/TimelineTypes";

/**
 * Phase 5 step-4 bridge: pair each enabled filter transform with its
 * time-sampled filter op via the shared transform stack. Uses real registered
 * filters (AlphaFilter / HslAdjustmentFilter) so dispatch routes correctly.
 */

const CTX: ApplyTransformStackContext = {
  container: { width: 1920, height: 1080 },
  content: { width: 1920, height: 1080 },
};

function filter(
  id: string,
  filterName: string,
  parameters: Record<string, unknown>,
  isEnabled = true,
): ClipTransform {
  return {
    id,
    type: "filter",
    isEnabled,
    parameters,
    // GenericFilterTransform carries filterName; dispatch routes on it.
    ...({ filterName } as object),
  } as ClipTransform;
}

function layout(): ClipTransform {
  return { id: "layout", type: "layout", isEnabled: true, parameters: {} };
}

describe("buildResolvedFilterOpLookup", () => {
  it("maps each enabled filter transform to its resolved op", () => {
    const blur = filter("blur", "AlphaFilter", { alpha: 0.5 });
    const colour = filter("colour", "HslAdjustmentFilter", { saturation: 0.3 });

    const lookup = buildResolvedFilterOpLookup(
      [layout(), blur, colour],
      CTX,
      0,
    );

    expect(lookup.size).toBe(2);
    expect(lookup.get(blur)).toEqual({
      type: "AlphaFilter",
      params: { alpha: 0.5 },
    });
    expect(lookup.get(colour)?.type).toBe("HslAdjustmentFilter");
    expect(lookup.get(colour)?.params.saturation).toBe(0.3);
  });

  it("excludes disabled filters and non-filter transforms", () => {
    const enabled = filter("a", "AlphaFilter", { alpha: 1 });
    const disabled = filter("b", "AlphaFilter", { alpha: 0.2 }, false);
    const lay = layout();

    const lookup = buildResolvedFilterOpLookup(
      [lay, enabled, disabled],
      CTX,
      0,
    );

    expect(lookup.has(enabled)).toBe(true);
    expect(lookup.has(disabled)).toBe(false);
    expect(lookup.has(lay)).toBe(false);
  });

  it("keeps the right op with each transform when filters are interleaved", () => {
    const a = filter("a", "AlphaFilter", { alpha: 0.25 });
    const b = filter("b", "HslAdjustmentFilter", { saturation: 0.9 });

    const lookup = buildResolvedFilterOpLookup([a, layout(), b], CTX, 0);

    // Positional zip must not cross the ops over.
    expect(lookup.get(a)?.type).toBe("AlphaFilter");
    expect(lookup.get(a)?.params.alpha).toBe(0.25);
    expect(lookup.get(b)?.type).toBe("HslAdjustmentFilter");
    expect(lookup.get(b)?.params.saturation).toBe(0.9);
  });

  it("does not mis-pair a valid op onto an unknown filter between valid filters", () => {
    const before = filter("before", "AlphaFilter", { alpha: 0.4 });
    const unknown = filter("unknown", "NotARegisteredFilter", { x: 1 });
    const after = filter("after", "HslAdjustmentFilter", { saturation: 0.7 });

    const lookup = buildResolvedFilterOpLookup([before, unknown, after], CTX, 0);

    // The unknown filter emits no op and must not steal a neighbour's.
    expect(lookup.has(unknown)).toBe(false);
    expect(lookup.get(before)).toEqual({
      type: "AlphaFilter",
      params: { alpha: 0.4 },
    });
    expect(lookup.get(after)?.type).toBe("HslAdjustmentFilter");
    expect(lookup.get(after)?.params.saturation).toBe(0.7);
  });

  it("returns an empty lookup for no transforms", () => {
    expect(buildResolvedFilterOpLookup([], CTX, 0).size).toBe(0);
    expect(buildResolvedFilterOpLookup(undefined, CTX, 0).size).toBe(0);
  });
});
