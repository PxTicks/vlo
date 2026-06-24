import { describe, expect, it } from "vitest";

import { getExternalFileDragHighlight } from "../assetDropSlotUtils";

function createDragData(type: string): Pick<DataTransfer, "types" | "items" | "files"> {
  return {
    types: ["Files"],
    items: [{ kind: "file", type }],
    files: [],
  } as unknown as Pick<DataTransfer, "types" | "items" | "files">;
}

describe("getExternalFileDragHighlight", () => {
  it("treats matching typed file items as compatible", () => {
    const highlight = getExternalFileDragHighlight(
      createDragData("image/png"),
      ["image"],
    );

    expect(highlight).toBe("compatible");
  });

  it("treats known mismatched file items as incompatible", () => {
    const highlight = getExternalFileDragHighlight(
      createDragData("video/mp4"),
      ["image"],
    );

    expect(highlight).toBe("incompatible");
  });

  it("falls back to a neutral highlight when file items expose no type yet", () => {
    const highlight = getExternalFileDragHighlight(
      createDragData(""),
      ["image"],
    );

    expect(highlight).toBe("external");
  });
});
