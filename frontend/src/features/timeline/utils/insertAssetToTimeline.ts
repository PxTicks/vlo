import type { Asset } from "../../../types/Asset";
import type {
  ClipTransform,
  TimelineClip,
} from "../../../types/TimelineTypes";
import { createClipFromAsset } from "./clipFactory";
import { useTimelineStore } from "../useTimelineStore";
import { getTrackTypeFromClipType } from "./formatting";

const DEFAULT_GENERATED_MASK_OUTER_FEATHER = 30;

function createDefaultGeneratedMaskTransforms(): ClipTransform[] {
  return [
    {
      id: crypto.randomUUID(),
      type: "feather",
      isEnabled: true,
      parameters: {
        mode: "hard_outer",
        amount: DEFAULT_GENERATED_MASK_OUTER_FEATHER,
      },
    },
  ];
}

/**
 * If the asset has a linked generation mask, attach it as a child mask clip.
 */
export function attachGenerationMask(
  clipId: string,
  asset: Asset,
): void {
  const meta = asset.creationMetadata;
  if (meta?.source !== "generated" || !meta.generationMaskAssetId) return;

  const store = useTimelineStore.getState();
  store.addClipMask(clipId, {
    id: crypto.randomUUID(),
    type: "generation",
    isEnabled: true,
    mode: "apply",
    inverted: false,
    parameters: { baseWidth: 1, baseHeight: 1 },
    generationMaskAssetId: meta.generationMaskAssetId,
    transformations: createDefaultGeneratedMaskTransforms(),
  });
}

/**
 * Inserts an asset into the timeline at the given start tick.
 *
 * Placement strategy: find the topmost track with content overlapping the
 * drop zone, then place the clip on the track directly above it (which is
 * guaranteed to be free in that region). If no track is occupied, place on
 * the bottom-most compatible track. If there's no track above (or no
 * compatible track), insert a new one.
 */
export function insertAssetAtTime(asset: Asset, startTick: number): void {
  const store = useTimelineStore.getState();
  const baseClip = createClipFromAsset(asset);
  const expectedTrackType = getTrackTypeFromClipType(baseClip.type);
  const endTick = startTick + baseClip.timelineDuration;

  const placeClip = (trackId: string) => {
    const clip: TimelineClip = { ...baseClip, trackId, start: startTick } as TimelineClip;
    store.addClip(clip);
    attachGenerationMask(clip.id, asset);
  };

  // Find the topmost track with content in the drop zone
  let topmostOccupiedIndex = -1;
  for (let i = 0; i < store.tracks.length; i++) {
    const trackId = store.tracks[i].id;
    const occupied = store.clips.some((c) => {
      if (c.trackId !== trackId) return false;
      const clipEnd = c.start + c.timelineDuration;
      return c.start < endTick && clipEnd > startTick;
    });
    if (occupied) {
      topmostOccupiedIndex = i;
      break;
    }
  }

  if (topmostOccupiedIndex === -1) {
    // Nothing occupied — use the bottom-most compatible track
    for (let i = store.tracks.length - 1; i >= 0; i--) {
      const track = store.tracks[i];
      if (!track.type || track.type === expectedTrackType) {
        placeClip(track.id);
        return;
      }
    }
  } else if (topmostOccupiedIndex > 0) {
    // Try the track directly above the topmost occupied one
    const aboveTrack = store.tracks[topmostOccupiedIndex - 1];
    if (!aboveTrack.type || aboveTrack.type === expectedTrackType) {
      placeClip(aboveTrack.id);
      return;
    }
  }

  // No suitable track — insert a new one just above the topmost occupied
  // track (or at index 0 if nothing was occupied).
  const insertIndex = Math.max(0, topmostOccupiedIndex);
  const newTrackId = store.insertTrack(insertIndex);
  placeClip(newTrackId);
}
