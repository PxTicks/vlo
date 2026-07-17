import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type { Asset } from "../../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import {
  createCompositeBakeKey,
  serializeCompositeBakeKey,
} from "../../../composite";
import { createCompositeSourcePolicySnapshot } from "../framePlanning/CompositeSourcePolicy";
import { createCompositeAudioTrackPlan } from "../CompositeAudioResolver";

const dimensions = { width: 1280, height: 720 };

function track(
  id: string,
  type: TimelineTrack["type"] = "visual",
  overrides: Partial<TimelineTrack> = {},
): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
    ...overrides,
  };
}

function clip(
  id: string,
  trackId: string,
  assetId: string,
  overrides: Partial<TimelineClip> = {},
): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId,
    assetId,
    start: 0,
    sourceDuration: TICKS_PER_SECOND * 4,
    transformedDuration: TICKS_PER_SECOND * 4,
    transformedOffset: 0,
    timelineDuration: TICKS_PER_SECOND * 4,
    croppedSourceDuration: TICKS_PER_SECOND * 4,
    offset: 0,
    transformations: [],
    ...overrides,
  } as TimelineClip;
}

function asset(id: string, hash = id): Asset {
  return {
    id,
    hash,
    name: id,
    type: "video",
    duration: 4,
    hasAudio: true,
    src: `blob:${id}`,
    creationMetadata: { source: "uploaded" },
  } as Asset;
}

function composite(
  childTracks: TimelineTrack[],
  childClips: TimelineClip[],
): CompositeAsset {
  return {
    id: "composite-1",
    name: "Composite",
    revision: 1,
    content: {
      tracks: childTracks,
      clips: childClips,
      durationTicks: TICKS_PER_SECOND * 4,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("createCompositeAudioTrackPlan", () => {
  it("expands live visual and audio tracks while respecting child mute state", () => {
    const parentTrack = track("parent");
    const childTracks = [
      track("child-visual"),
      track("child-audio", "audio"),
      track("muted", "audio", { isMuted: true }),
      track("hidden", "visual", { isVisible: false }),
    ];
    const childClips = [
      clip("visual-audio", "child-visual", "child-asset"),
      clip("audio", "child-audio", "child-asset", {
        type: "audio",
        isMuted: true,
      }),
      clip("muted-track", "muted", "child-asset", { type: "audio" }),
      clip("hidden-track", "hidden", "child-asset"),
    ];
    const sourceComposite = composite(childTracks, childClips);
    const placement = clip("parent-clip", parentTrack.id, "live-sentinel", {
      compositeId: sourceComposite.id,
      compositeRevision: 1,
    });

    const plan = createCompositeAudioTrackPlan(parentTrack.id, {
      tracks: [parentTrack],
      clips: [placement],
      composites: [sourceComposite],
      assets: [asset("child-asset")],
      projectFps: 30,
      logicalDimensions: dimensions,
    });

    expect(plan.mainClips).toEqual([]);
    expect(plan.directPlacements).toHaveLength(1);
    expect(plan.directPlacements[0].lanes).toHaveLength(2);
    expect(
      plan.directPlacements[0].lanes.flatMap((lane) => lane.clips),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: "child-asset" }),
        expect.objectContaining({ type: "audio", isMuted: true }),
      ]),
    );
  });

  it("uses the composed parent and child source-time mapping", () => {
    const parentTrack = track("parent");
    const childTrack = track("child-audio", "audio");
    const child = clip("child", childTrack.id, "child-asset", {
      type: "audio",
      transformations: [
        {
          id: "child-speed",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 0.5 },
        },
      ],
    });
    const sourceComposite = composite([childTrack], [child]);
    const placement = clip("parent-clip", parentTrack.id, "live-sentinel", {
      compositeId: sourceComposite.id,
      compositeRevision: 1,
      transformations: [
        {
          id: "parent-speed",
          type: "speed",
          isEnabled: true,
          parameters: { factor: 2 },
        },
      ],
    });

    const plan = createCompositeAudioTrackPlan(parentTrack.id, {
      tracks: [parentTrack],
      clips: [placement],
      composites: [sourceComposite],
      assets: [asset("child-asset")],
      projectFps: 30,
      logicalDimensions: dimensions,
    });
    const lane = plan.directPlacements[0].lanes[0];
    const presentationTick = TICKS_PER_SECOND;
    const active = lane.timingResolver.findActiveClipAtPresentation(
      lane.clips,
      presentationTick,
    );

    expect(active?.clip.id).toContain("child");
    expect(
      lane.timingResolver.getSourceTicksAtPresentationTick(
        active!.clip,
        presentationTick,
      ),
    ).toBeCloseTo(TICKS_PER_SECOND);
  });

  it("keeps a matching bake on the ordinary media path", () => {
    const parentTrack = track("parent");
    const childTrack = track("child");
    const child = clip("child", childTrack.id, "child-asset");
    const childAsset = asset("child-asset", "child-hash");
    const bakeAsset = asset("bake-asset", "bake-hash");
    const sourceComposite = composite([childTrack], [child]);
    const readyKey = serializeCompositeBakeKey(
      createCompositeBakeKey({
        content: sourceComposite.content,
        projectFps: 30,
        logicalDimensions: dimensions,
        assets: [childAsset, bakeAsset],
      }),
    );
    sourceComposite.bake = {
      status: "ready",
      requestedKey: readyKey,
      readyKey,
      readyRevision: 1,
      assetId: bakeAsset.id,
    };
    const placement = clip("parent-clip", parentTrack.id, bakeAsset.id, {
      compositeId: sourceComposite.id,
      compositeRevision: 1,
    });
    const source = {
      tracks: [parentTrack],
      clips: [placement],
      composites: [sourceComposite],
      assets: [childAsset, bakeAsset],
      projectFps: 30,
      logicalDimensions: dimensions,
    };

    const automatic = createCompositeAudioTrackPlan(parentTrack.id, source);
    expect(automatic.directPlacements).toEqual([]);
    expect(automatic.mainClips[0]).toEqual(
      expect.objectContaining({ assetId: bakeAsset.id }),
    );

    const forcedLive = createCompositeAudioTrackPlan(parentTrack.id, {
      ...source,
      sourcePolicy: createCompositeSourcePolicySnapshot({
        forceLiveCompositeIds: new Set([sourceComposite.id]),
      }),
    });
    expect(forcedLive.mainClips).toEqual([]);
    expect(forcedLive.directPlacements).toHaveLength(1);
  });
});
