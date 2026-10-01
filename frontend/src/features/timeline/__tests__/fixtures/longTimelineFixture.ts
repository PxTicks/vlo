import { mediaSecondsToTick } from "../../../../core/time/mediaTime";
import { TIMELINE_DOCUMENT_SCHEMA_VERSION } from "../../../project/constants";
import {
  timelineDocumentSchema,
  type TimelineDocument,
} from "../../../project/schemas/projectPersistenceSchemas";
import { cloneClipWithMasks } from "../../model/maskClipModel";
import type { MarkerEntry, MarkersComponent } from "../../../../types/Components";
import type {
  AudioTimelineClip,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";

/**
 * Synthetic long timelines for the performance lane and its counter tests.
 *
 * A real project's timeline (by default the `project_current` e2e fixture) is
 * repeated end to end. Each copy goes through `cloneClipWithMasks`, the same
 * re-ID path that split and duplicate use, so mask children, `mask_ref`
 * components and `mask_composition` expressions stay consistent without a
 * second implementation of the ID rules. The result has unique IDs, unlike
 * the `vlo_03_repeated` reference project.
 */

export const LONG_TIMELINE_AUDIO_TRACK_ID = "track_long_timeline_audio";

/** Default copies of `project_current`: ~1,400 clips, close to the reference project. */
export const LONG_TIMELINE_DEFAULT_REPETITIONS = 110;

const DEFAULT_BEAT_INTERVAL_TICKS = mediaSecondsToTick(0.5);
const BEATS_PER_BAR = 4;

export interface LongTimelineAudioOptions {
  /** An audio asset that exists in the fixture's asset index. */
  assetId: string;
  name: string;
  sourceDurationTicks: number;
  beatIntervalTicks?: number;
}

export interface LongTimelineFixtureOptions {
  repetitions: number;
  /** Adds an audio track carrying one beat-marked clip per block. */
  audio?: LongTimelineAudioOptions;
}

export interface LongTimelineFixture {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions: Transition[];
  /** Timeline span of one block; copy `n` starts at `n * blockTicks`. */
  blockTicks: number;
  clipsPerBlock: number;
}

/** The audio asset shipped with `e2e/fixtures/project_current`. */
export const PROJECT_CURRENT_BEAT_AUDIO: LongTimelineAudioOptions = {
  assetId: "014b2934-1e89-432b-b7e9-d25ffccf8122",
  name: "hf_20260122_232943_45d72e1c-68cb-41b8-bdac-e275e5c91de8-audio.m4a",
  sourceDurationTicks: 1_153_024,
};

export function repeatedClipId(sourceId: string, repetition: number): string {
  return `${sourceId}-r${repetition}`;
}

/**
 * Repeats `baseTimeline` (a parsed `timeline.json`) `repetitions` times.
 * The input is validated against the current timeline schema so a stale
 * base fails here rather than as a confusing render error later.
 */
export function buildLongTimelineFixture(
  baseTimeline: unknown,
  options: LongTimelineFixtureOptions,
): LongTimelineFixture {
  const base = timelineDocumentSchema.parse(baseTimeline);
  const tracks = structuredClone(base.tracks);
  const blockClips: TimelineClip[] = [...base.clips];

  if (options.audio) {
    tracks.push({
      id: LONG_TIMELINE_AUDIO_TRACK_ID,
      type: "audio",
      label: "Beats",
      isVisible: true,
      isMuted: false,
      isLocked: false,
    });
    blockClips.push(createBeatMarkedAudioClip(options.audio));
  }

  const blockTicks = Math.max(
    ...blockClips.map((clip) => clip.start + clip.timelineDuration),
  );
  const parents = blockClips.filter((clip) => clip.type !== "mask");
  const clips: TimelineClip[] = [];
  const transitions: Transition[] = [];

  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    const shift = repetition * blockTicks;
    for (const parent of parents) {
      clips.push(
        ...cloneClipWithMasks(
          { ...parent, start: parent.start + shift },
          blockClips,
          repeatedClipId(parent.id, repetition),
        ),
      );
    }
    for (const transition of base.transitions) {
      transitions.push({
        ...structuredClone(transition),
        id: repeatedClipId(transition.id, repetition),
        outgoingClipId: repeatedClipId(transition.outgoingClipId, repetition),
        incomingClipId: repeatedClipId(transition.incomingClipId, repetition),
      });
    }
  }

  const clipsPerBlock = options.repetitions > 0
    ? clips.length / options.repetitions
    : 0;
  if (clipsPerBlock !== blockClips.length) {
    // A mask whose parent is missing from the base would be silently dropped.
    throw new Error(
      `Long timeline fixture lost clips: ${blockClips.length} per block in, ${clipsPerBlock} out`,
    );
  }

  return { tracks, clips, transitions, blockTicks, clipsPerBlock };
}

export function toLongTimelineDocument(
  fixture: LongTimelineFixture,
  updatedAt = 0,
): TimelineDocument {
  return {
    documentType: "vlo.timeline",
    schemaVersion: TIMELINE_DOCUMENT_SCHEMA_VERSION,
    updated_at: updatedAt,
    tracks: fixture.tracks,
    clips: fixture.clips,
    transitions: fixture.transitions,
  };
}

function createBeatMarkedAudioClip(
  audio: LongTimelineAudioOptions,
): AudioTimelineClip {
  const interval = audio.beatIntervalTicks ?? DEFAULT_BEAT_INTERVAL_TICKS;
  const markers: MarkerEntry[] = [];
  for (
    let index = 0, time = 0;
    time < audio.sourceDurationTicks;
    index += 1, time += interval
  ) {
    markers.push({
      id: `beat_${index}`,
      sourceTimeTicks: time,
      kind: index % BEATS_PER_BAR === 0 ? "downbeat" : "beat",
    });
  }
  const markersComponent: MarkersComponent = {
    id: "beats",
    type: "markers",
    parameters: { markers },
  };

  return {
    id: "clip_long_timeline_beats",
    type: "audio",
    assetId: audio.assetId,
    name: audio.name,
    trackId: LONG_TIMELINE_AUDIO_TRACK_ID,
    start: 0,
    offset: 0,
    sourceDuration: audio.sourceDurationTicks,
    transformedDuration: audio.sourceDurationTicks,
    transformedOffset: 0,
    timelineDuration: audio.sourceDurationTicks,
    croppedSourceDuration: audio.sourceDurationTicks,
    transformations: [],
    components: [markersComponent],
  };
}
