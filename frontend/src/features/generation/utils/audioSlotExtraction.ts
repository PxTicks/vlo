import type { Asset } from "../../../types/Asset";
import type { GenerationMediaInputValue } from "../types";
import type { GenerationWorkflowState } from "../store/types";
import { isAudioSlotVideoAsset } from "./audioSlotAssets";
import { extractAudioFromVideo } from "./manualSlotMedia";
import { resolveAssetFileForGeneration } from "./mediaInputAssets";

export const NO_ASSET_AUDIO_TRACK_MESSAGE =
  "No audio track was found in this video";

type SetMediaInputAsset = GenerationWorkflowState["setMediaInputAsset"];

/**
 * True while `value` is still the extraction this request started: the same
 * slot, the same asset, the same request id, still marked extracting. Anything
 * else means the user has since replaced, cleared, or moved the value, and the
 * result must be dropped rather than written back.
 */
export function isAssetSlotExtractionCurrent(
  value: GenerationMediaInputValue | null | undefined,
  assetId: string,
  extractionRequestId: number,
): boolean {
  return (
    value?.kind === "asset" &&
    value.asset.id === assetId &&
    value.isExtracting === true &&
    (value.extractionRequestId ?? 0) === extractionRequestId
  );
}

/**
 * Finds slots left holding a value that is marked extracting but whose
 * extraction no longer belongs to them — the state a value lands in when a
 * reorder or a repeatable-slot clear moves it while its extraction is still
 * running. Those need restarting where the value came to rest, or they stay
 * "extracting" forever.
 */
export function collectStalledAudioExtractions(
  inputIds: readonly string[],
  getSlotValue: (inputId: string) => GenerationMediaInputValue | null,
): Array<{ inputId: string; asset: Asset }> {
  const stalled: Array<{ inputId: string; asset: Asset }> = [];

  for (const inputId of new Set(inputIds)) {
    const value = getSlotValue(inputId);
    if (value?.kind === "asset" && value.isExtracting) {
      stalled.push({ inputId, asset: value.asset });
    }
  }

  return stalled;
}

interface AudioAssetExtractionOptions {
  inputId: string;
  asset: Asset;
  extractionRequestId: number;
  setMediaInputAsset: SetMediaInputAsset;
  /**
   * Returns false once a newer drop has superseded this one, so a slow
   * extraction never overwrites the slot's current value.
   */
  isCurrentRequest?: () => boolean;
}

/**
 * Pulls the audio track out of a video asset that was dropped on an audio
 * slot, writing the result (or the failure) back into the slot. Assumes the
 * slot has already been put into its extracting state.
 */
export async function extractAudioForAssetSlot({
  inputId,
  asset,
  extractionRequestId,
  setMediaInputAsset,
  isCurrentRequest,
}: AudioAssetExtractionOptions): Promise<void> {
  const stillCurrent = () => isCurrentRequest?.() !== false;

  try {
    const sourceFile = await resolveAssetFileForGeneration(asset);
    const extractedAudioFile = await extractAudioFromVideo(sourceFile);
    if (!stillCurrent()) return;
    setMediaInputAsset(inputId, asset, {
      isExtracting: false,
      extractionRequestId,
      extractedAudioFile,
      extractionError:
        extractedAudioFile === null ? NO_ASSET_AUDIO_TRACK_MESSAGE : null,
    });
  } catch (error) {
    console.error("Failed to extract audio from generation asset input", error);
    if (!stillCurrent()) return;
    setMediaInputAsset(inputId, asset, {
      isExtracting: false,
      extractionRequestId,
      extractedAudioFile: null,
      extractionError:
        error instanceof Error
          ? error.message
          : "Failed to extract audio from this video",
    });
  }
}

/**
 * Fills an audio slot with `asset`. Audio assets land directly; a video asset
 * lands in its extracting state and its audio track is pulled in the
 * background. Returns the extraction promise when one was started.
 */
export function fillAudioSlotWithAsset({
  inputId,
  asset,
  extractionRequestId,
  setMediaInputAsset,
  isCurrentRequest,
}: AudioAssetExtractionOptions): Promise<void> | null {
  if (!isAudioSlotVideoAsset(asset)) {
    setMediaInputAsset(inputId, asset);
    return null;
  }

  setMediaInputAsset(inputId, asset, {
    isExtracting: true,
    extractionRequestId,
  });

  return extractAudioForAssetSlot({
    inputId,
    asset,
    extractionRequestId,
    setMediaInputAsset,
    isCurrentRequest,
  });
}
