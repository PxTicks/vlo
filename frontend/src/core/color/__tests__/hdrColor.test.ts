import { describe, expect, it } from "vitest";
import {
  applyColorInputTransform,
  applyMatrix3,
  BT2020_TO_REC709,
  hlgEotf,
  hlgOetf,
  pqEotf,
  pqOetf,
} from "..";

describe("HDR color transforms", () => {
  it("round-trips ST 2084 PQ reference values", () => {
    expect(pqEotf(0)).toBe(0);
    expect(pqEotf(1)).toBeCloseTo(1, 8);
    expect(pqEotf(0.50807842)).toBeCloseTo(0.01, 5);
    expect(pqOetf(pqEotf(0.75))).toBeCloseTo(0.75, 8);
  });

  it("round-trips BT.2100 HLG across its join", () => {
    expect(hlgEotf(0.5)).toBeCloseTo(1 / 12, 8);
    expect(hlgOetf(1 / 12)).toBeCloseTo(0.5, 8);
    expect(hlgOetf(hlgEotf(0.8))).toBeCloseTo(0.8, 8);
  });

  it("converts BT.2020 primaries into the Rec.709 working space", () => {
    const red = applyMatrix3(BT2020_TO_REC709, [1, 0, 0]);
    expect(red[0]).toBeGreaterThan(1.6);
    expect(red[1]).toBeLessThan(0);
    const white = applyColorInputTransform([1, 1, 1], {
      transform: "hlg-bt2020",
    });
    white.forEach((channel) => expect(channel).toBeCloseTo(1, 5));
  });
});
