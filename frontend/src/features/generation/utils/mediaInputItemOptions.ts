import type { GenerationMediaInputValue } from "../types";
import { isVideoAssetWithAudio } from "./audioSlotAssets";

/**
 * Per-item switches live on the media input value, which is a union: only the
 * kinds that can deliver a soundtrack carry the flag. These readers keep every
 * caller from re-deriving that narrowing.
 */
export function readIncludeEmbeddedAudio(
  value: GenerationMediaInputValue,
): boolean {
  if (value.kind === "asset") return value.includeEmbeddedAudio === true;
  return (
    value.kind === "timelineSelection" &&
    value.mediaType === "video" &&
    value.includeEmbeddedAudio === true
  );
}

/**
 * Whether a batch video item can offer the audio switch at all. A library
 * asset knows whether it has a soundtrack; a timeline selection is rendered
 * with its included tracks, so it stays capable until it is prepared.
 */
export function canValueCarryAudio(value: GenerationMediaInputValue): boolean {
  if (value.kind === "asset") return isVideoAssetWithAudio(value.asset);
  return value.kind === "timelineSelection" && value.mediaType === "video";
}
