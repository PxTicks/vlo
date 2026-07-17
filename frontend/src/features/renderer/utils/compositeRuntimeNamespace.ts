import type {
  CompositeContent,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";

export interface NamespacedCompositeContent {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions: Transition[];
}

function runtimeId(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

/**
 * Creates placement-private runtime ids without mutating persisted composite
 * content. Asset ids and mask-local expression ids remain shared/canonical;
 * every scene-owned track, clip, component, and transition id is namespaced.
 */
export function namespaceCompositeRuntimeContent(
  content: CompositeContent,
  placementId: string,
): NamespacedCompositeContent {
  const prefix = `${placementId}::composite::`;
  const authoredTracks = content.tracks ?? [];
  const fallbackTrackIds = [
    ...new Set(content.clips.map((clip) => clip.trackId)),
  ];
  const tracks =
    authoredTracks.length > 0
      ? authoredTracks
      : fallbackTrackIds.map<TimelineTrack>((id) => ({
          id,
          type: "visual",
          label: "Composite track",
          isVisible: true,
          isMuted: false,
          isLocked: false,
        }));
  const trackIdMap = new Map(
    tracks.map((track) => [track.id, runtimeId(prefix, track.id)]),
  );
  const clipIdMap = new Map(
    content.clips.map((clip) => [clip.id, runtimeId(prefix, clip.id)]),
  );
  const mapTrackId = (id: string): string => trackIdMap.get(id) ?? id;
  const mapClipId = (id: string): string => clipIdMap.get(id) ?? id;

  const namespacedClips = structuredClone(content.clips).map((clip) => {
    clip.id = mapClipId(clip.id);
    clip.trackId = mapTrackId(clip.trackId);
    if (clip.type === "mask" && clip.parentClipId) {
      clip.parentClipId = mapClipId(clip.parentClipId);
    }
    if (clip.type !== "mask" && clip.components) {
      clip.components = clip.components.map((component) => {
        const next = { ...component, id: runtimeId(prefix, component.id) };
        if (next.type === "mask_ref") {
          return {
            ...next,
            parameters: {
              ...next.parameters,
              maskClipId: mapClipId(next.parameters.maskClipId),
            },
          };
        }
        return next;
      });
    }
    return clip;
  });

  return {
    tracks: structuredClone(tracks).map((track) => ({
      ...track,
      id: mapTrackId(track.id),
      type: track.type ?? "visual",
    })),
    clips: namespacedClips,
    transitions: structuredClone(content.transitions ?? []).map(
      (transition) => ({
        ...transition,
        id: runtimeId(prefix, transition.id),
        outgoingClipId: mapClipId(transition.outgoingClipId),
        incomingClipId: mapClipId(transition.incomingClipId),
      }),
    ),
  };
}
