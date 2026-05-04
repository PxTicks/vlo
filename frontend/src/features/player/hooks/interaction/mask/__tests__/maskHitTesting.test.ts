import { describe, expect, it } from "vitest";
import type {
  MaskTimelineClip,
  TimelineClip,
} from "../../../../../../types/TimelineTypes";
import {
  createMaskLayoutTransforms,
  type MaskShapeSource,
} from "../../../../../masks/model/maskFactory";
import { findEditableMaskTargetAtPoint } from "../maskHitTesting";

const activeClip = {
  id: "clip_1",
  trackId: "track_1",
  type: "video",
  start: 0,
  timelineDuration: 100,
  offset: 0,
  transformedDuration: 100,
  transformedOffset: 0,
} as TimelineClip;

function createMaskClip(localId: string): MaskTimelineClip {
  const id = `${activeClip.id}::mask::${localId}`;
  return {
    id,
    trackId: activeClip.trackId,
    type: "mask",
    name: localId,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: createMaskLayoutTransforms(id, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    }),
    parentClipId: activeClip.id,
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
  };
}

function createHitShape(maskClip: MaskTimelineClip): MaskShapeSource {
  return {
    id: maskClip.id,
    maskType: maskClip.maskType,
    maskParameters: maskClip.maskParameters,
    transformations: maskClip.transformations,
  };
}

describe("findEditableMaskTargetAtPoint", () => {
  it("prefers the selected mask when overlapping masks are under the pointer", () => {
    const first = createMaskClip("first");
    const second = createMaskClip("second");

    const target = findEditableMaskTargetAtPoint({
      global: { x: 10, y: 10 },
      activeClip,
      masks: [first, second],
      selectedMaskId: "first",
      toClipLocal: (point) => point,
      canEditMask: () => true,
      resolveHitShape: createHitShape,
    });

    expect(target?.maskLocalId).toBe("first");
  });

  it("falls back to reverse mask order for non-selected masks", () => {
    const first = createMaskClip("first");
    const second = createMaskClip("second");

    const target = findEditableMaskTargetAtPoint({
      global: { x: 10, y: 10 },
      activeClip,
      masks: [first, second],
      selectedMaskId: null,
      toClipLocal: (point) => point,
      canEditMask: () => true,
      resolveHitShape: createHitShape,
    });

    expect(target?.maskLocalId).toBe("second");
  });

  it("skips masks that the current tool cannot edit", () => {
    const first = createMaskClip("first");
    const second = createMaskClip("second");

    const target = findEditableMaskTargetAtPoint({
      global: { x: 10, y: 10 },
      activeClip,
      masks: [first, second],
      selectedMaskId: "first",
      toClipLocal: (point) => point,
      canEditMask: (maskClip) => maskClip.id !== first.id,
      resolveHitShape: createHitShape,
    });

    expect(target?.maskLocalId).toBe("second");
  });
});
