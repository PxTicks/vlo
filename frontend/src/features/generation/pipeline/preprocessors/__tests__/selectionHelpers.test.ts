import { describe, expect, it } from "vitest";
import type { TimelineSelection } from "../../../../../types/TimelineTypes";
import {
  applySelectionConfigDefaults,
  prepareNormalizedSelection,
  resolveExportFps,
  resolveSelectionFpsForVideoSelection,
} from "../selectionHelpers";

function createSelection(
  overrides: Partial<TimelineSelection> = {},
): TimelineSelection {
  return {
    start: 0,
    end: 1000,
    clips: [],
    ...overrides,
  };
}

describe("selectionHelpers", () => {
  it("does not replace a missing selection fps with selection config export fps", () => {
    const selection = createSelection();

    expect(
      applySelectionConfigDefaults(selection, {
        exportFps: 12,
        frameStep: 4,
      }),
    ).toEqual({
      ...selection,
      frameStep: 4,
    });
  });

  it("falls back to project fps when selection fps is missing", () => {
    const selection = createSelection();

    expect(resolveExportFps(selection, { exportFps: 12 }, 24)).toBe(24);
    expect(resolveSelectionFpsForVideoSelection(selection, { exportFps: 12 }, 24)).toBe(
      24,
    );
    expect(prepareNormalizedSelection(selection, 24, { exportFps: 12 })).toEqual({
      ...selection,
      fps: 24,
    });
  });

  it("preserves an explicit selection fps", () => {
    const selection = createSelection({ fps: 48 });

    expect(resolveExportFps(selection, { exportFps: 12 }, 24)).toBe(48);
    expect(resolveSelectionFpsForVideoSelection(selection, { exportFps: 12 }, 24)).toBe(
      48,
    );
    expect(prepareNormalizedSelection(selection, 24, { exportFps: 12 })).toEqual(
      selection,
    );
  });
});
