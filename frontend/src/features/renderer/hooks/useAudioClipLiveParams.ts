import { useEffect } from "react";
import { useTimelineClipsForTrack } from "../../timeline/api";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { notifyClipLiveParams } from "../../transformations/applyTransformations";
import type { AdjustmentEffectResolver } from "../services/AdjustmentEffectResolver";
import { findActiveClipAtPresentation } from "../utils/clipLookup";

/**
 * Publish the live parameter values of the audio clip under the playhead.
 *
 * Visual clips get this from their render pass; audio clips have none, so
 * without it their panel controls stay pinned to the clip-start value. This is
 * independent of audio scheduling so muted tracks still publish.
 */
export function useAudioClipLiveParams(
  trackId: string,
  adjustmentEffectResolver?: AdjustmentEffectResolver | null,
) {
  const trackClips = useTimelineClipsForTrack(trackId, false);

  useEffect(() => {
    const resolver = adjustmentEffectResolver ?? null;
    const publish = (presentationTick: number) => {
      const active = findActiveClipAtPresentation(
        resolver,
        trackId,
        trackClips,
        presentationTick,
      );
      if (!active || active.clip.type !== "audio") return;
      notifyClipLiveParams(
        active.clip,
        active.effectiveTick - active.clip.start,
      );
    };

    publish(playbackClock.time);
    const unsubscribeClock = playbackClock.subscribe(publish);
    // Timing edits rebuild the presentation lookup after this effect runs.
    const unsubscribeSource = resolver?.subscribeToSource(() =>
      publish(playbackClock.time),
    );
    return () => {
      unsubscribeClock();
      unsubscribeSource?.();
    };
  }, [adjustmentEffectResolver, trackClips, trackId]);
}
