import type { MaskTimelineClip } from "../../../types/TimelineTypes";
import type { MaskLayoutState } from "./maskFactory";
import { applyClipTransforms } from "../../transformations";

/**
 * Lightweight layout probe target that mimics a PixiJS display object.
 */
interface LayoutProbeTarget {
  position: {
    x: number;
    y: number;
    set: (x: number, y: number) => void;
  };
  scale: {
    x: number;
    y: number;
    set: (x: number, y: number) => void;
  };
  rotation: number;
}

function createLayoutProbeTarget(): LayoutProbeTarget {
  const position = {
    x: 0,
    y: 0,
    set(x: number, y: number) {
      this.x = x;
      this.y = y;
    },
  };
  const scale = {
    x: 1,
    y: 1,
    set(x: number, y: number) {
      this.x = x;
      this.y = y;
    },
  };

  return {
    position,
    scale,
    rotation: 0,
  };
}

const ORIGIN_LAYOUT_CONTAINER = {
  width: 1,
  height: 1,
};

export function getMaskClipContentSize(maskClip: MaskTimelineClip): {
  width: number;
  height: number;
} {
  const params = maskClip.maskParameters;
  return {
    width: Math.max(1, params?.baseWidth ?? 1),
    height: Math.max(1, params?.baseHeight ?? 1),
  };
}

/**
 * Resolves a mask clip's layout at a specific clip-local visual time (ticks).
 * The mask clip is a first-class TimelineClip — no projection needed.
 */
export function resolveMaskLayoutStateAtTime(
  maskClip: MaskTimelineClip,
  rawTimeTicks: number,
): MaskLayoutState {
  const probe = createLayoutProbeTarget();

  applyClipTransforms(
    probe,
    maskClip,
    ORIGIN_LAYOUT_CONTAINER,
    rawTimeTicks,
    getMaskClipContentSize(maskClip),
    { baseLayoutMode: "origin", notifyLiveParams: false },
  );

  return {
    x: probe.position.x,
    y: probe.position.y,
    scaleX: probe.scale.x,
    scaleY: probe.scale.y,
    rotation: probe.rotation,
  };
}
