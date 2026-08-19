import type { Asset } from "../../../types/Asset";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";

/** The asset fields the audio-slot predicates need. */
export type AudioSlotAssetCandidate = Pick<
  Asset,
  "type" | "file" | "name" | "src" | "hasAudio"
>;

/**
 * A video asset is a candidate for an audio slot when it carries an audio
 * track. `hasAudio` is probed at ingest for every video, but assets ingested
 * before that flag existed leave it undefined — those stay candidates and
 * extraction becomes the real gate, matching the tolerance the timeline's
 * "extract audio" action already uses.
 */
export function isVideoAssetWithAudio(asset: AudioSlotAssetCandidate): boolean {
  return assetMatchesType(asset, "video") && asset.hasAudio !== false;
}

/**
 * What an audio slot accepts from a *drag*. A library asset's `hasAudio` is
 * already known, so a silent video is refused up front rather than accepted
 * and then reported as empty.
 */
export function canDropAssetOnAudioSlot(asset: AudioSlotAssetCandidate): boolean {
  return assetMatchesType(asset, "audio") || isVideoAssetWithAudio(asset);
}

/**
 * What an audio slot may *hold*. Wider than {@link canDropAssetOnAudioSlot}:
 * an external file drop only learns `hasAudio` after ingest, so a video that
 * turns out to be silent still occupies its slot — carrying the "no audio
 * track" error that explains why — instead of vanishing on the next prune.
 */
export function canAudioSlotHoldAsset(asset: AudioSlotAssetCandidate): boolean {
  return assetMatchesType(asset, "audio") || assetMatchesType(asset, "video");
}

/**
 * True for a value that presents as extracted audio rather than as its own
 * media: a video occupying an audio slot.
 */
export function isAudioSlotVideoAsset(asset: AudioSlotAssetCandidate): boolean {
  return assetMatchesType(asset, "video");
}
