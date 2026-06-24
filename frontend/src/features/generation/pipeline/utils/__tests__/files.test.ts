import { describe, expect, it } from "vitest";
import {
  extensionForMimeType,
  extractTrailingNumber,
  fileExtension,
  renameWithExtension,
  sortFrameFilesBySequence,
  stripExtension,
} from "../files";

describe("generation file utilities", () => {
  it("extracts and strips extensions", () => {
    expect(fileExtension("FRAME.PNG")).toBe(".png");
    expect(fileExtension("archive.tar.gz")).toBe(".gz");
    expect(fileExtension("no-extension")).toBe("");
    expect(stripExtension("archive.tar.gz")).toBe("archive.tar");
    expect(stripExtension("no-extension")).toBe("no-extension");
  });

  it.each([
    ["image/jpeg", ".jpg"],
    ["image/webp", ".webp"],
    ["image/bmp", ".bmp"],
    ["image/png", ".png"],
    ["video/mp4", ".mp4"],
    ["application/octet-stream", ""],
  ])("maps %s to %s", (mimeType, extension) => {
    expect(extensionForMimeType(mimeType)).toBe(extension);
  });

  it("renames files without duplicating extensions", () => {
    expect(renameWithExtension("frame.jpeg", ".png")).toBe("frame.png");
    expect(renameWithExtension("frame", ".png")).toBe("frame.png");
    expect(renameWithExtension("frame.png", "")).toBe("frame.png");
  });

  it("extracts the final numeric sequence", () => {
    expect(extractTrailingNumber("frame_001_final_42.png")).toBe(42);
    expect(extractTrailingNumber("frame.png")).toBeNull();
  });

  it("sorts numbered frames first and uses names as a stable fallback", () => {
    const frames = [
      new File([], "zeta.png"),
      new File([], "frame_10.png"),
      new File([], "alpha.png"),
      new File([], "frame_2.png"),
    ];

    expect(sortFrameFilesBySequence(frames).map((file) => file.name)).toEqual([
      "frame_2.png",
      "frame_10.png",
      "alpha.png",
      "zeta.png",
    ]);
    expect(frames.map((file) => file.name)).toEqual([
      "zeta.png",
      "frame_10.png",
      "alpha.png",
      "frame_2.png",
    ]);
  });
});
