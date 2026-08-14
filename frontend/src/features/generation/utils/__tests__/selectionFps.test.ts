import { describe, expect, it } from "vitest";

import { resolveSelectionConfigFps } from "../selectionFps";

describe("resolveSelectionConfigFps", () => {
  it("follows the project frame rate when the rule links to it", () => {
    expect(resolveSelectionConfigFps({ exportFps: "project" }, 24)).toBe(24);
    expect(resolveSelectionConfigFps({ exportFps: "project" }, 30)).toBe(30);
  });

  it("keeps a pinned frame rate independent of the project", () => {
    expect(resolveSelectionConfigFps({ exportFps: 16 }, 24)).toBe(16);
  });

  it("expresses no preference when the rule omits a frame rate", () => {
    expect(resolveSelectionConfigFps(undefined, 24)).toBeNull();
    expect(resolveSelectionConfigFps({}, 24)).toBeNull();
    expect(resolveSelectionConfigFps({ frameStep: 4 }, 24)).toBeNull();
  });

  it("rejects unusable rates from either side of the link", () => {
    expect(resolveSelectionConfigFps({ exportFps: 0 }, 24)).toBeNull();
    expect(resolveSelectionConfigFps({ exportFps: -1 }, 24)).toBeNull();
    expect(resolveSelectionConfigFps({ exportFps: "project" }, 0)).toBeNull();
    expect(
      resolveSelectionConfigFps({ exportFps: "project" }, Number.NaN),
    ).toBeNull();
  });
});
