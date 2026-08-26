import { describe, expect, it } from "vitest";
import {
  evaluateExtensionSdkCompatibility,
  evaluateExtensionVloCompatibility,
} from "../sdkCompatibility";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";

// Ranges are written against the current host SDK on purpose: a version bump
// should force a deliberate review of what it makes (in)compatible.
describe("evaluateExtensionSdkCompatibility", () => {
  it.each([
    "1.18.0",
    "=1.18.0",
    ">=1.0.0 <2.0.0",
    ">= 1.0.0 < 2.0.0",
    ">1.0.0 <=1.18.0",
  ])("accepts compatible v1 ranges: %s", (range) => {
    expect(evaluateExtensionSdkCompatibility(range)).toMatchObject({
      compatible: true,
      valid: true,
      sdkVersion: VLO_EXTENSION_SDK_VERSION,
    });
  });

  // An exact pin to a superseded SDK no longer activates: the batch is
  // pre-release, so ranges — not pins — are the supported declaration.
  it.each(["1.0.0", "1.17.0", "<=1.17.0", ">1.18.0", ">=2.0.0"])(
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

describe("evaluateExtensionVloCompatibility", () => {
  it("uses the same comparator grammar for a known application version", () => {
    expect(
      evaluateExtensionVloCompatibility(">=0.2.0 <0.3.0", "0.2.0"),
    ).toMatchObject({ compatible: true, valid: true });
    expect(
      evaluateExtensionVloCompatibility(">=0.3.0", "0.2.0"),
    ).toMatchObject({ compatible: false, valid: true });
    expect(
      evaluateExtensionVloCompatibility("^0.2.0", "0.2.0"),
    ).toMatchObject({ compatible: false, valid: false });
  });

  it("warns and allows activation when the host build version is unknown", () => {
    expect(
      evaluateExtensionVloCompatibility(">=0.2.0 <0.3.0", null),
    ).toMatchObject({
      compatible: true,
      valid: true,
      warning: expect.stringContaining("could not be verified"),
    });
  });
});
