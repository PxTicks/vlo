// @vitest-environment node

import { describe, expect, it } from "vitest";
import { timelineDocumentSchema } from "../../project/schemas/projectPersistenceSchemas";
import {
  collectMaskBooleanExpressionMaskIds,
  getMaskCompositionComponent,
  getMaskLocalIdFromMaskClipId,
} from "../../masks/model/maskBooleanExpression";
import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  LONG_TIMELINE_AUDIO_TRACK_ID,
  PROJECT_CURRENT_BEAT_AUDIO,
  buildLongTimelineFixture,
  toLongTimelineDocument,
} from "./fixtures/longTimelineFixture";
import { readProjectCurrentTimeline } from "./fixtures/longTimelineFixtureSource";

const REPETITIONS = 4;

function buildFixture() {
  return buildLongTimelineFixture(readProjectCurrentTimeline(), {
    repetitions: REPETITIONS,
    audio: PROJECT_CURRENT_BEAT_AUDIO,
  });
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => (seen.has(value) ? true : !seen.add(value)));
}

describe("buildLongTimelineFixture", () => {
  it("writes a document the current timeline schema accepts", () => {
    const fixture = buildFixture();

    expect(() =>
      timelineDocumentSchema.parse(toLongTimelineDocument(fixture)),
    ).not.toThrow();
    // project_current's 12 clips plus the beat-marked audio clip.
    expect(fixture.clipsPerBlock).toBe(13);
    expect(fixture.clips).toHaveLength(13 * REPETITIONS);
  });

  it("gives every clip and transition a unique id", () => {
    const fixture = buildFixture();

    expect(duplicates(fixture.clips.map((clip) => clip.id))).toEqual([]);
    expect(duplicates(fixture.transitions.map((t) => t.id))).toEqual([]);
  });

  it("keeps mask, mask_ref, composition and transition links inside each copy", () => {
    const fixture = buildFixture();
    const byId = new Map(fixture.clips.map((clip) => [clip.id, clip]));
    let checkedExpressionMaskIds = 0;

    for (const clip of fixture.clips) {
      if (clip.type === "mask") {
        const parent = byId.get(clip.parentClipId ?? "");
        expect(parent, clip.id).toBeDefined();
        expect(clip.id.startsWith(`${clip.parentClipId}::mask::`)).toBe(true);
        expect(clip.start).toBe(parent?.start);
        continue;
      }

      const childMaskIds = new Set<string>();
      for (const component of clip.components ?? []) {
        if (component.type !== "mask_ref") continue;
        const mask = byId.get(component.parameters.maskClipId);
        expect(mask?.type, component.parameters.maskClipId).toBe("mask");
        expect((mask as Extract<TimelineClip, { type: "mask" }>).parentClipId)
          .toBe(clip.id);
        childMaskIds.add(
          getMaskLocalIdFromMaskClipId(component.parameters.maskClipId) ?? "",
        );
      }
      const expression = getMaskCompositionComponent(clip)?.parameters.expression;
      for (const maskId of collectMaskBooleanExpressionMaskIds(expression)) {
        expect(childMaskIds.has(maskId), `${clip.id} -> ${maskId}`).toBe(true);
        checkedExpressionMaskIds += 1;
      }
    }
    // project_current composes 3 + 1 masks per copy.
    expect(checkedExpressionMaskIds).toBe(4 * REPETITIONS);

    for (const transition of fixture.transitions) {
      expect(byId.has(transition.outgoingClipId)).toBe(true);
      expect(byId.has(transition.incomingClipId)).toBe(true);
    }
  });

  it("places copies end to end without overlapping clips on a track", () => {
    const fixture = buildFixture();
    const byTrack = new Map<string, TimelineClip[]>();
    for (const clip of fixture.clips) {
      if (clip.type === "mask") continue;
      byTrack.set(clip.trackId, [...(byTrack.get(clip.trackId) ?? []), clip]);
    }

    for (const [trackId, clips] of byTrack) {
      const sorted = [...clips].sort((a, b) => a.start - b.start);
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1];
        expect(
          sorted[index].start,
          `${trackId}: ${previous.id} overlaps ${sorted[index].id}`,
        ).toBeGreaterThanOrEqual(previous.start + previous.timelineDuration);
      }
    }

    const beats = fixture.clips.filter(
      (clip) => clip.trackId === LONG_TIMELINE_AUDIO_TRACK_ID,
    );
    expect(beats.map((clip) => clip.start)).toEqual(
      Array.from({ length: REPETITIONS }, (_, n) => n * fixture.blockTicks),
    );
  });
});
