import type {
  TimelineClip,
  TimelineSelection,
  TimelineTrack,
  TrackType,
} from "../../../types/TimelineTypes";
import type { ProjectData } from "../services/ExportRenderer";

function inferTrackType(clips: readonly TimelineClip[]): TrackType {
  if (clips.some((clip) => clip.type === "adjustment")) return "adjustment";
  if (clips.some((clip) => clip.type === "audio")) return "audio";
  if (clips.every((clip) => clip.type === "mask")) return "mask";
  return "visual";
}

function getSelectionTracks(selection: TimelineSelection): TimelineTrack[] {
  if (selection.tracks) {
    return selection.tracks;
  }

  if (import.meta.env.DEV) {
    console.warn(
      "[Renderer] A supplied timelineSelection omitted tracks; deriving detached track records from its clips. Pass the complete snapshot topology instead.",
    );
  }

  const clipsByTrackId = new Map<string, TimelineClip[]>();
  for (const clip of selection.clips) {
    const trackClips = clipsByTrackId.get(clip.trackId) ?? [];
    trackClips.push(clip);
    clipsByTrackId.set(clip.trackId, trackClips);
  }

  return [...clipsByTrackId].map(([trackId, clips]) => ({
    id: trackId,
    type: inferTrackType(clips),
    label: "Saved selection",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  }));
}

function getSelectionDuration(selection: TimelineSelection): number {
  const furthestClipEnd = selection.clips.reduce(
    (end, clip) => Math.max(end, clip.start + clip.timelineDuration),
    selection.start,
  );

  return Math.max(selection.end ?? selection.start, furthestClipEnd);
}

/**
 * Treats a persisted timeline selection as a self-contained mini-project.
 * Assets and composites remain project-level resources resolved by stable id,
 * while timeline topology must come exclusively from the saved snapshot.
 */
export function buildSelectionProjectData(
  projectData: ProjectData,
  selection: TimelineSelection,
): ProjectData {
  return {
    ...projectData,
    tracks: getSelectionTracks(selection),
    clips: selection.clips,
    transitions: selection.transitions ?? [],
    duration: getSelectionDuration(selection),
  };
}
