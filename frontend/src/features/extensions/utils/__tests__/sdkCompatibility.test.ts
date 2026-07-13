import { describe, expect, it } from "vitest";
import { evaluateExtensionSdkCompatibility } from "../sdkCompatibility";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";

// Ranges are written against the current host SDK on purpose: a version bump
// should force a deliberate review of what it makes (in)compatible.
describe("evaluateExtensionSdkCompatibility", () => {
  it.each([
    "1.2.0",
    "=1.2.0",
    ">=1.0.0 <2.0.0",
    ">= 1.0.0 < 2.0.0",
    ">1.0.0 <=1.2.0",
  ])("accepts compatible v1 ranges: %s", (range) => {
    expect(evaluateExtensionSdkCompatibility(range)).toMatchObject({
      compatible: true,
      valid: true,
      sdkVersion: VLO_EXTENSION_SDK_VERSION,
    });
  });

  it.each(["1.0.0", "<=1.0.0", ">1.2.0", ">=2.0.0"])(
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
