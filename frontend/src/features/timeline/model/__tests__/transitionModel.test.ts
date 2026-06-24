import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../../types/TimelineTypes";
import {
  resolveTransition,
  resolveTransitionProgress,
  resolveTransitions,
} from "../transitionModel";
import { pruneInvalidTransitions } from "../timelineCommands";
import type { TimelineModelState } from "../timelineTrackModel";
import { TICKS_PER_SECOND } from "../../constants";

function track(id: string): TimelineTrack {
  return {
    id,
    type: "visual",
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function clip(
  id: string,
  trackId: string,
  start: number,
  duration: number,
): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId: `asset-${id}`,
    start,
    timelineDuration: duration,
    sourceDuration: duration,
    croppedSourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

const transition: Transition = {
  id: "transition-1",
  type: "dissolve",
  outgoingClipId: "outgoing",
  incomingClipId: "incoming",
  parameters: {},
};

describe("transitionModel", () => {
  it("derives the frame-quantized overlap across adjacent visual tracks", () => {
    const resolved = resolveTransition(
      transition,
      [track("upper"), track("lower")],
      [
        clip("outgoing", "upper", 0, 100),
        clip("incoming", "lower", 60, 100),
      ],
      TICKS_PER_SECOND,
    );

    expect(resolved).toMatchObject({
      start: 60,
      end: 100,
      duration: 40,
      outgoingTrackIndex: 0,
      incomingTrackIndex: 1,
    });
  });

  it("rejects non-adjacent and non-overlapping pairs", () => {
    const tracks = [track("upper"), track("middle"), track("lower")];
    expect(
      resolveTransition(
        transition,
        tracks,
        [
          clip("outgoing", "upper", 0, 100),
          clip("incoming", "lower", 60, 100),
        ],
        TICKS_PER_SECOND,
      ),
    ).toBeNull();

    expect(
      resolveTransition(
        transition,
        tracks.slice(0, 2),
        [
          clip("outgoing", "upper", 0, 50),
          clip("incoming", "middle", 50, 50),
        ],
        TICKS_PER_SECOND,
      ),
    ).toBeNull();
  });

  it("clamps progress to the transition window", () => {
    const window = { start: 10, end: 30 };
    expect(resolveTransitionProgress(window, 0)).toBe(0);
    expect(resolveTransitionProgress(window, 20)).toBe(0.5);
    expect(resolveTransitionProgress(window, 40)).toBe(1);
  });

  it("resolves several transitions against one shared timeline context", () => {
    const tracks = [
      track("upper-a"),
      track("lower-a"),
      track("upper-b"),
      track("lower-b"),
    ];
    const clips = [
      clip("outgoing-a", "upper-a", 0, 100),
      clip("incoming-a", "lower-a", 50, 100),
      clip("outgoing-b", "upper-b", 0, 100),
      clip("incoming-b", "lower-b", 25, 100),
    ];

    expect(
      resolveTransitions(
        [
          {
            ...transition,
            id: "transition-a",
            outgoingClipId: "outgoing-a",
            incomingClipId: "incoming-a",
          },
          {
            ...transition,
            id: "transition-b",
            outgoingClipId: "outgoing-b",
            incomingClipId: "incoming-b",
          },
        ],
        tracks,
        clips,
        TICKS_PER_SECOND,
      ).map((resolved) => resolved.transition.id),
    ).toEqual(["transition-a", "transition-b"]);
  });

  it("keeps the first valid transition when imported entries share a clip", () => {
    const draft: TimelineModelState = {
      tracks: [track("upper"), track("middle"), track("lower")],
      clips: [
        clip("upper-clip", "upper", 0, 100),
        clip("shared-clip", "middle", 25, 100),
        clip("lower-clip", "lower", 50, 100),
      ],
      transitions: [
        {
          ...transition,
          id: "first",
          outgoingClipId: "upper-clip",
          incomingClipId: "shared-clip",
        },
        {
          ...transition,
          id: "second",
          outgoingClipId: "shared-clip",
          incomingClipId: "lower-clip",
        },
      ],
    };

    pruneInvalidTransitions(draft, TICKS_PER_SECOND);

    expect(draft.transitions.map((candidate) => candidate.id)).toEqual([
      "first",
    ]);
  });
});
