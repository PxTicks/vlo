import { describe, expect, it } from "vitest";
import type { ClipTransform } from "../../../../../types/TimelineTypes";
import {
  insertTransformRespectingDefaultOrder,
  reorderDynamicTransforms,
} from "../transformOrdering";

function createTransform(id: string, type: string): ClipTransform {
  return {
    id,
    type,
    isEnabled: true,
    parameters: {},
  };
}

describe("transformOrdering", () => {
  it("inserts default transforms before the first dynamic transform", () => {
    const transforms = [
      createTransform("speed-1", "speed"),
      createTransform("filter-1", "filter"),
    ];

    const inserted = createTransform("position-1", "position");
    const result = insertTransformRespectingDefaultOrder(transforms, inserted);

    expect(result.map((transform) => transform.id)).toEqual([
      "position-1",
      "speed-1",
      "filter-1",
    ]);
  });

  it("appends when there are no dynamic transforms", () => {
    const transforms = [
      createTransform("position-1", "position"),
      createTransform("scale-1", "scale"),
    ];

    const inserted = createTransform("rotation-1", "rotation");
    const result = insertTransformRespectingDefaultOrder(transforms, inserted);

    expect(result.map((transform) => transform.id)).toEqual([
      "position-1",
      "scale-1",
      "rotation-1",
    ]);
  });

  it("reorders only dynamic transforms while preserving base order", () => {
    const transforms = [
      createTransform("position-1", "position"),
      createTransform("rotation-1", "rotation"),
      createTransform("speed-1", "speed"),
      createTransform("filter-1", "filter"),
      createTransform("speed-2", "speed"),
    ];

    const result = reorderDynamicTransforms(transforms, "speed-2", "speed-1");

    expect(result?.map((transform) => transform.id)).toEqual([
      "position-1",
      "rotation-1",
      "speed-2",
      "speed-1",
      "filter-1",
    ]);
  });
});
