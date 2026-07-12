import { describe, expect, it } from "vitest";
import type { ClipTransform } from "../../../../types/TimelineTypes";
import {
  getTransformationDefinitionTab,
  getTransformationTab,
} from "../transformationTabs";
import {
  getDefaultTransforms,
  getEntryByFilterName,
  getEntryByType,
} from "../../catalogue/TransformationRegistry";

describe("transformationTabs", () => {
  it("places layout, fit and blend definitions in Display", () => {
    const displayTypes = getDefaultTransforms()
      .filter(
        (definition) =>
          getTransformationDefinitionTab(definition) === "display",
      )
      .map((definition) => definition.type);

    expect(displayTypes).toEqual(["layout", "fitMode", "blendMode"]);
  });

  it("places speed in its own tab", () => {
    expect(getTransformationDefinitionTab(getEntryByType("speed"))).toBe(
      "speed",
    );
  });

  it("places audio-only definitions in Audio", () => {
    expect(getTransformationDefinitionTab(getEntryByType("volume"))).toBe(
      "audio",
    );
  });

  it("reserves Color Grading for the complete color grade transform", () => {
    expect(
      getTransformationDefinitionTab(
        getEntryByFilterName("ColorGradeFilter"),
      ),
    ).toBe("color");
    expect(
      getTransformationDefinitionTab(
        getEntryByFilterName("HslAdjustmentFilter"),
      ),
    ).toBe("display");
    expect(
      getTransformationDefinitionTab(getEntryByFilterName("AdjustmentFilter")),
    ).toBe("display");
  });

  it("keeps PixiJS filters and missing transformations in Display", () => {
    const blur = {
      id: "blur-1",
      type: "filter",
      filterName: "BlurFilter",
      isEnabled: true,
      parameters: {},
    } as ClipTransform;
    const missing = {
      id: "missing-1",
      type: "example/missing",
      isEnabled: true,
      parameters: {},
    } as ClipTransform;

    expect(getTransformationTab(blur)).toBe("display");
    expect(getTransformationTab(missing)).toBe("display");
  });
});
