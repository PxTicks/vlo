import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureGradePresetParameters,
  clearCopiedGradeParameters,
  copyGradeParameters,
  readCopiedGradeParameters,
} from "../gradeParameters";

describe("grade parameter clipboard", () => {
  afterEach(() => {
    clearCopiedGradeParameters();
    vi.unstubAllGlobals();
  });

  it("reads a grade envelope when the in-memory copy is unavailable", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: vi.fn().mockResolvedValue(
          JSON.stringify({
            type: "vlo-color-grade",
            version: 1,
            parameters: { exposure: 1 },
          }),
        ),
      },
    });

    await expect(readCopiedGradeParameters()).resolves.toEqual({ exposure: 1 });
  });

  it("removes project-local LUT IDs from cross-project presets", () => {
    expect(
      captureGradePresetParameters({
        exposure: 1,
        lutAssetId: "project-a-lut",
        _gradeManagement: true,
      }),
    ).toEqual({ exposure: 1 });
  });

  it("rejects unrelated clipboard JSON", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: vi.fn().mockResolvedValue('{"type":"other"}'),
      },
    });

    await expect(readCopiedGradeParameters()).resolves.toBeNull();
  });

  it("remaps copied spline points into the destination source-time range", async () => {
    copyGradeParameters(
      {
        exposure: {
          type: "spline",
          points: [
            { time: 100, value: 0 },
            { time: 300, value: 1 },
          ],
        },
      },
      { minTime: 100, duration: 200 },
    );

    await expect(
      readCopiedGradeParameters({ minTime: 500, duration: 100 }),
    ).resolves.toEqual({
      exposure: {
        type: "spline",
        points: [
          { time: 500, value: 0 },
          { time: 600, value: 1 },
        ],
      },
    });
  });
});
