import { describe, expect, it } from "vitest";

import { getExternalFileDragHighlight } from "../AssetDropSlot";

describe("getExternalFileDragHighlight", () => {
  it("treats matching typed file items as compatible", () => {
    const highlight = getExternalFileDragHighlight(
      {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png" }] as DataTransferItem[],
        files: [] as FileList,
      },
      ["image"],
    );

    expect(highlight).toBe("compatible");
  });

  it("treats known mismatched file items as incompatible", () => {
    const highlight = getExternalFileDragHighlight(
      {
        types: ["Files"],
        items: [{ kind: "file", type: "video/mp4" }] as DataTransferItem[],
        files: [] as FileList,
      },
      ["image"],
    );

    expect(highlight).toBe("incompatible");
  });

  it("falls back to a neutral highlight when file items expose no type yet", () => {
    const highlight = getExternalFileDragHighlight(
      {
        types: ["Files"],
        items: [{ kind: "file", type: "" }] as DataTransferItem[],
        files: [] as FileList,
      },
      ["image"],
    );

    expect(highlight).toBe("external");
  });
});
