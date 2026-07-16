import { describe, expect, it } from "vitest";
import { DEFAULT_MATRIX_RAIN_PARAMETERS } from "../constants";
import { MATRIX_RAIN_RECIPES } from "../recipes";
import { validateMatrixRainAuthoredParameters } from "../utils/parameterValidation";

describe("Matrix Rain recipes", () => {
  it.each(Object.entries(MATRIX_RAIN_RECIPES))(
    "%s stays inside the authored parameter contract",
    (_id, recipe) => {
      expect(
        validateMatrixRainAuthoredParameters({
          ...DEFAULT_MATRIX_RAIN_PARAMETERS,
          ...recipe.parameters,
        }),
      ).toBe(true);
    },
  );

  it("documents Matrix followed by native Bloom", () => {
    expect(MATRIX_RAIN_RECIPES.bloomHeads.followWith).toEqual({
      filterName: "BloomFilter",
      parameters: { strength: 2.5, quality: 4 },
    });
    expect(MATRIX_RAIN_RECIPES.bloomHeads.parameters.headIntensity).toBeGreaterThan(
      MATRIX_RAIN_RECIPES.bloomHeads.parameters.rainStrength,
    );
  });
});
