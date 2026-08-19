import { describe, expect, it } from "vitest";
import type { Asset } from "../../../../types/Asset";
import {
  canAudioSlotHoldAsset,
  canDropAssetOnAudioSlot,
  isVideoAssetWithAudio,
} from "../audioSlotAssets";

function makeAsset(overrides: Partial<Asset>): Asset {
  return {
    id: "asset-1",
    hash: "hash",
    name: "clip.mp4",
    type: "video",
    src: "assets/clip.mp4",
    createdAt: Date.now(),
    ...overrides,
  } as Asset;
}

describe("audioSlotAssets", () => {
  it("accepts a video asset whose ingest probe found an audio track", () => {
    expect(isVideoAssetWithAudio(makeAsset({ hasAudio: true }))).toBe(true);
  });

  it("rejects a video asset the ingest probe found silent", () => {
    expect(isVideoAssetWithAudio(makeAsset({ hasAudio: false }))).toBe(false);
  });

  it("accepts a legacy video asset ingested before hasAudio was recorded", () => {
    expect(isVideoAssetWithAudio(makeAsset({ hasAudio: undefined }))).toBe(true);
  });

  it("rejects non-video assets", () => {
    expect(
      isVideoAssetWithAudio(
        makeAsset({ type: "image", name: "frame.png", src: "assets/frame.png" }),
      ),
    ).toBe(false);
    expect(
      isVideoAssetWithAudio(
        makeAsset({ type: "audio", name: "song.wav", src: "assets/song.wav" }),
      ),
    ).toBe(false);
  });

  it("accepts a drop of an audio asset or a video known to have audio", () => {
    expect(
      canDropAssetOnAudioSlot(
        makeAsset({ type: "audio", name: "song.wav", src: "assets/song.wav" }),
      ),
    ).toBe(true);
    expect(canDropAssetOnAudioSlot(makeAsset({ hasAudio: true }))).toBe(true);
    expect(canDropAssetOnAudioSlot(makeAsset({ hasAudio: false }))).toBe(false);
  });

  it("lets a slot hold a silent video, so its error can be shown rather than pruned", () => {
    // An external file drop only learns hasAudio after ingest, so the slot has
    // to be able to hold what it could not screen at drag time.
    expect(canAudioSlotHoldAsset(makeAsset({ hasAudio: false }))).toBe(true);
    expect(
      canAudioSlotHoldAsset(
        makeAsset({ type: "image", name: "frame.png", src: "assets/frame.png" }),
      ),
    ).toBe(false);
  });

  it("resolves the type from the filename when asset.type is stale", () => {
    // Generated assets can carry a stale stored type; the extension wins.
    expect(
      isVideoAssetWithAudio(
        makeAsset({ type: "image", name: "clip.mp4", src: "assets/clip.mp4" }),
      ),
    ).toBe(true);
  });
});
