import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StandardTimelineClip } from "../../../types/TimelineTypes";
import type { MaskCompositionComponent } from "../../../types/Components";
import { useTimelineStore } from "../../timeline";
import { useMaskViewStore } from "../../masks/store/useMaskViewStore";
import { createMaskLayoutTransforms } from "../../masks/model/maskFactory";
import { useTransformationController } from "../hooks/useTransformationController";
import { TICKS_PER_SECOND } from "../../timeline";

function getCompositeTransforms(clip: StandardTimelineClip | undefined) {
  const composition = (clip?.components ?? []).find(
    (component): component is MaskCompositionComponent =>
      component.type === "mask_composition",
  );
  return composition?.parameters.compositeTransformations ?? [];
}

const clipId = "clip-mask-target";
const maskId = "mask-transform-target";
const maskClipId = `${clipId}::mask::${maskId}`;

describe("useTransformationController mask target", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      clips: [
        {
          id: clipId,
          trackId: "track-1",
          start: 0,
          timelineDuration: 8 * TICKS_PER_SECOND,
          offset: 0,
          type: "video",
          croppedSourceDuration: 8 * TICKS_PER_SECOND,
          name: "Mask Transform Clip",
          sourceDuration: 8 * TICKS_PER_SECOND,
          transformedDuration: 8 * TICKS_PER_SECOND,
          transformedOffset: 0,
          transformations: [],
          components: [
            {
              id: "mask_ref_1",
              type: "mask_ref",
              parameters: { maskClipId },
            },
          ],
        },
        {
          id: maskClipId,
          trackId: "track-1",
          start: 0,
          timelineDuration: 8 * TICKS_PER_SECOND,
          offset: 0,
          type: "mask",
          croppedSourceDuration: 8 * TICKS_PER_SECOND,
          name: "Mask Transform Target",
          sourceDuration: 8 * TICKS_PER_SECOND,
          transformedDuration: 8 * TICKS_PER_SECOND,
          transformedOffset: 0,
          parentClipId: clipId,
          maskType: "rectangle",
          maskMode: "apply",
          maskInverted: false,
          maskParameters: {
            baseWidth: 100,
            baseHeight: 100,
          },
          transformations: createMaskLayoutTransforms(maskClipId, {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
          }),
        },
      ],
      selectedClipIds: [clipId],
    });

    useMaskViewStore.setState({
      selectedMaskByClipId: { [clipId]: maskId },
      pendingDrawRequest: null,
      interactionContext: null,
    });
  });

  it("commits layout edits to the selected mask transform stack", () => {
    const { result } = renderHook(() =>
      useTransformationController({ target: "mask" }),
    );

    expect(result.current.activeTargetKind).toBe("mask");

    act(() => {
      result.current.handleCommit("position", "x", 42);
    });

    const state = useTimelineStore.getState();
    const maskClip = state.clips.find((clip) => clip.id === maskClipId);
    const positionTransform = maskClip?.transformations.find(
      (transform) => transform.type === "position",
    );

    expect(positionTransform?.parameters).toEqual(
      expect.objectContaining({ x: 42 }),
    );

    const parentClip = state.clips.find((clip) => clip.id === clipId);
    expect(parentClip?.transformations).toEqual([]);
  });

  it("commits shared mask edge edits to the parent clip", () => {
    const { result } = renderHook(() =>
      useTransformationController({ target: "maskComposite" }),
    );

    expect(result.current.activeTargetKind).toBe("maskComposite");

    act(() => {
      result.current.handleCommit("mask_grow", "amount", 18);
    });

    const state = useTimelineStore.getState();
    const parentClip = state.clips.find(
      (clip): clip is StandardTimelineClip =>
        clip.id === clipId && clip.type !== "mask",
    );
    const maskClip = state.clips.find((clip) => clip.id === maskClipId);

    expect(parentClip?.type).toBe("video");
    expect(getCompositeTransforms(parentClip)).toEqual([
      expect.objectContaining({
        type: "mask_grow",
        parameters: {
          amount: 18,
          invert: false,
        },
      }),
    ]);
    expect(
      maskClip?.transformations.some((transform) => transform.type === "mask_grow"),
    ).toBe(false);
  });
});
