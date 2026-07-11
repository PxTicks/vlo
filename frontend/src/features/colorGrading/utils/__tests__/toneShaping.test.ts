import { describe, expect, it } from "vitest";
import {
  highlightRolloffStrength,
  shadowLiftStrength,
  toneMacroUpdate,
} from "../toneShaping";

describe("tone shaping macros", () => {
  it("keeps zero strength mathematically inactive", () => {
    expect(toneMacroUpdate("highlight", 0)).toEqual({
      kneeThreshold: 1,
      kneeSoftness: 0,
    });
    expect(toneMacroUpdate("shadow", 0)).toEqual({
      toeAmount: 0,
      toeSoftness: 0,
    });
  });

  it("activates both parameters with one highlight or shadow adjustment", () => {
    const highlight = toneMacroUpdate("highlight", 0.5);
    const shadow = toneMacroUpdate("shadow", 0.5);
    expect(highlight.kneeThreshold).toBeCloseTo(0.9);
    expect(highlight.kneeSoftness).toBeCloseTo(0.15);
    expect(shadow).toEqual({ toeAmount: 0.5, toeSoftness: 0.25 });
    expect(
      highlightRolloffStrength({
        kneeThreshold: highlight.kneeThreshold ?? 1,
        kneeSoftness: highlight.kneeSoftness ?? 0,
        toeAmount: 0,
        toeSoftness: 0,
      }),
    ).toBeCloseTo(0.5);
    expect(
      shadowLiftStrength({
        kneeThreshold: 1,
        kneeSoftness: 0,
        toeAmount: shadow.toeAmount ?? 0,
        toeSoftness: shadow.toeSoftness ?? 0,
      }),
    ).toBeCloseTo(0.5);
  });
});
