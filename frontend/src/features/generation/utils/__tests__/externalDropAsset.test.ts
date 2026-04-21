import { describe, expect, it, vi } from "vitest";

import type { Asset } from "../../../../types/Asset";
import { resolveExistingAssetForExternalDrop } from "../externalDropAsset";

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    hash: "hash-1",
    name: "reference.png",
    type: "image",
    src: "reference.png",
    createdAt: 1,
    ...overrides,
  };
}

describe("resolveExistingAssetForExternalDrop", () => {
  it("prefers a sanitized filename match before hashing", async () => {
    const asset = createAsset({ name: "reference.png" });
    const computeChecksum = vi.fn(async () => "hash-1");

    const result = await resolveExistingAssetForExternalDrop(
      new File(["image"], "reference.png", { type: "image/png" }),
      [asset],
      {
        sanitizeFilename: (name) => name,
        computeChecksum,
      },
    );

    expect(result).toBe(asset);
    expect(computeChecksum).not.toHaveBeenCalled();
  });

  it("falls back to a hash match when the filename differs", async () => {
    const asset = createAsset({
      id: "asset-2",
      hash: "hash-2",
      name: "stored-reference.png",
    });
    const computeChecksum = vi.fn(async () => "hash-2");

    const result = await resolveExistingAssetForExternalDrop(
      new File(["image"], "external-name.png", { type: "image/png" }),
      [asset],
      {
        sanitizeFilename: (name) => name,
        computeChecksum,
      },
    );

    expect(result).toBe(asset);
    expect(computeChecksum).toHaveBeenCalledTimes(1);
  });

  it("returns null when no existing asset matches", async () => {
    const asset = createAsset();

    const result = await resolveExistingAssetForExternalDrop(
      new File(["image"], "missing.png", { type: "image/png" }),
      [asset],
      {
        sanitizeFilename: (name) => name,
        computeChecksum: async () => "hash-missing",
      },
    );

    expect(result).toBeNull();
  });
});
