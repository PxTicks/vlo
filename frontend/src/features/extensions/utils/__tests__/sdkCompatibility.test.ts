import { describe, expect, it } from "vitest";
import { evaluateExtensionSdkCompatibility } from "../sdkCompatibility";

describe("evaluateExtensionSdkCompatibility", () => {
  it.each([
    "1.1.0",
    "=1.1.0",
    ">=1.0.0 <2.0.0",
    ">= 1.0.0 < 2.0.0",
    ">1.0.0 <=1.1.0",
  ])("accepts compatible v1 ranges: %s", (range) => {
    expect(evaluateExtensionSdkCompatibility(range)).toMatchObject({
      compatible: true,
      valid: true,
      sdkVersion: "1.1.0",
    });
  });

  it.each(["1.0.0", "<=1.0.0", ">1.1.0", ">=2.0.0"])(
    "rejects incompatible ranges: %s",
    (range) => {
      expect(evaluateExtensionSdkCompatibility(range)).toMatchObject({
        compatible: false,
        valid: true,
      });
    },
  );

  it.each(["", "^1.0.0", ">=1", "1.0.0 || 2.0.0", "latest"])(
    "fails closed for unsupported range syntax: %s",
    (range) => {
      expect(evaluateExtensionSdkCompatibility(range)).toMatchObject({
        compatible: false,
        valid: false,
      });
    },
  );
});
