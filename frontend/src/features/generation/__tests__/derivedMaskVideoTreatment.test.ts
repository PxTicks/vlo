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

  it("applies conditional source video treatment defaults from workflow params", () => {
    expect(
      resolveDefaultDerivedMaskSourceVideoTreatment(
        {
          mask_processing: {
            source_video_treatment: {
              default: "fill_transparent_with_neutral_gray",
              default_overrides: [
                {
                  when: {
                    node_id: "92",
                    param: "denoise",
                    operator: "lt",
                    value: 1,
                  },
                  value: "remove_transparency",
                },
              ],
            },
          },
        },
        {
          workflow: {
            "92": {
              inputs: {
                denoise: 0.6,
              },
            },
          },
        },
      ),
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
