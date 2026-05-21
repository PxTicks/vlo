import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import { isAssetVisibleInBrowser } from "../assetVisibility";

type CreationSource = NonNullable<Asset["creationMetadata"]>["source"];

function assetWithSource(source: CreationSource): Asset {
  return {
    id: `asset-${source}`,
    hash: `hash-${source}`,
    name: `${source}.mp4`,
    type: "video",
    src: `${source}.mp4`,
    createdAt: 1,
    creationMetadata: { source } as Asset["creationMetadata"],
  };
}

describe("isAssetVisibleInBrowser", () => {
  it("hides internal composite proxy assets", () => {
    expect(isAssetVisibleInBrowser(assetWithSource("composite"))).toBe(false);
  });

  it("keeps uploaded assets visible", () => {
    expect(isAssetVisibleInBrowser(assetWithSource("uploaded"))).toBe(true);
  });
});
