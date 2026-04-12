import { describe, expect, it } from "vitest";

import {
  resolveDefaultDerivedMaskSourceVideoTreatment,
  resolveDerivedMaskVideoTreatments,
} from "../derivedMaskVideoTreatment";

describe("derivedMaskVideoTreatment", () => {
  it("reads the default source video treatment from mask_processing rules", () => {
    expect(
      resolveDefaultDerivedMaskSourceVideoTreatment({
        mask_processing: {
          source_video_treatment: {
            default: "remove_transparency",
          },
        },
      }),
    ).toBe("remove_transparency");
  });

  it("falls back to the mask_processing default when no widget is exposed", () => {
    expect(
      resolveDerivedMaskVideoTreatments(
        [{ sourceNodeId: "1" }],
        [],
        {},
        "fill_transparent_with_neutral_gray",
      ),
    ).toEqual({
      "1": "fill_transparent_with_neutral_gray",
    });
  });
});
