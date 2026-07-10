import { describe, expect, it } from "vitest";
import { COLOR_GRADE_FILTER_NAME } from "../filters/colorGrade";
import { preResolveFilterOperations } from "../filterPreResolution";

describe("filter pre-resolution", () => {
  it("fuses contiguous color grades without crossing another filter", () => {
    const resolved = preResolveFilterOperations([
      {
        type: COLOR_GRADE_FILTER_NAME,
        sourceTransformId: "grade-a",
        params: { exposure: 1 },
      },
      {
        type: COLOR_GRADE_FILTER_NAME,
        sourceTransformId: "grade-b",
        params: { contrast: 1.2 },
      },
      { type: "BlurFilter", sourceTransformId: "blur", params: { strength: 2 } },
      {
        type: COLOR_GRADE_FILTER_NAME,
        sourceTransformId: "grade-c",
        params: { saturation: 0.5 },
      },
    ]);

    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatchObject({
      type: COLOR_GRADE_FILTER_NAME,
      params: {
        grades: [
          { transformId: "grade-a", parameters: { exposure: 1 } },
          { transformId: "grade-b", parameters: { contrast: 1.2 } },
        ],
      },
    });
    expect(resolved[1].type).toBe("BlurFilter");
    expect(resolved[2].params.grades).toEqual([
      { transformId: "grade-c", parameters: { saturation: 0.5 } },
    ]);
  });
});
