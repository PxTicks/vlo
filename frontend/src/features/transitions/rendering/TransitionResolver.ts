import type {
  ClipTransform,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";
import type { DerivedRenderGroup } from "../../renderer/utils/deriveAdjustmentGroups";
import {
  resolveActiveTransitions,
  resolveTransitionProgress,
} from "../../timeline/model/transitionModel";
import { getTransitionDefinition } from "../catalogue/TransitionRegistry";
import { buildTransitionTransforms } from "./buildTransitionTransforms";

export interface TransitionColorLayer {
  id: string;
  color: string;
  parentGroupId: string | null;
  zIndex: number;
}

export interface ResolvedTransitionFrame {
  transformsByClipId: ReadonlyMap<string, readonly ClipTransform[]>;
  zIndexOverrides: ReadonlyMap<string, number>;
  colorLayers: readonly TransitionColorLayer[];
}

function buildParentGroupByTrack(
  forest: readonly DerivedRenderGroup[],
): Map<string, string> {
  const parentByTrack = new Map<string, string>();
  const walk = (group: DerivedRenderGroup): void => {
    group.trackIds.forEach((trackId) => parentByTrack.set(trackId, group.id));
    group.children.forEach(walk);
  };
  forest.forEach(walk);
  return parentByTrack;
}

export function resolveTransitionFrame(options: {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  transitions: readonly Transition[];
  fps: number;
  presentationTick: number;
  logicalDimensions: { width: number; height: number };
  visualTrackOrder: readonly string[];
  adjustmentForest: readonly DerivedRenderGroup[];
}): ResolvedTransitionFrame {
  const transformsByClipId = new Map<string, ClipTransform[]>();
  const zIndexOverrides = new Map<string, number>();
  const colorLayers: TransitionColorLayer[] = [];
  const active = resolveActiveTransitions(
    options.transitions,
    options.tracks,
    options.clips,
    options.fps,
    options.presentationTick,
  );
  const parentGroupByTrack = buildParentGroupByTrack(options.adjustmentForest);
  const baseZByTrack = new Map(
    options.visualTrackOrder.map(
      (trackId, index) =>
        [trackId, options.visualTrackOrder.length - 1 - index] as const,
    ),
  );

  for (const resolved of active) {
    if (
      !baseZByTrack.has(resolved.outgoingClip.trackId) ||
      !baseZByTrack.has(resolved.incomingClip.trackId)
    ) {
      continue;
    }
    const progress = resolveTransitionProgress(
      resolved,
      options.presentationTick,
    );
    transformsByClipId.set(
      resolved.outgoingClip.id,
      buildTransitionTransforms(
        resolved.transition,
        "outgoing",
        progress,
        options.logicalDimensions,
      ),
    );
    transformsByClipId.set(
      resolved.incomingClip.id,
      buildTransitionTransforms(
        resolved.transition,
        "incoming",
        progress,
        options.logicalDimensions,
      ),
    );

    const outgoingParent =
      parentGroupByTrack.get(resolved.outgoingClip.trackId) ?? null;
    const incomingParent =
      parentGroupByTrack.get(resolved.incomingClip.trackId) ?? null;
    const sharedParent =
      outgoingParent === incomingParent ? outgoingParent : null;

    const outgoingZ = baseZByTrack.get(resolved.outgoingClip.trackId) ?? 0;
    const incomingZ = baseZByTrack.get(resolved.incomingClip.trackId) ?? 0;
    if (
      outgoingParent === incomingParent &&
      getTransitionDefinition(resolved.transition.type).hijackZOrder
    ) {
      zIndexOverrides.set(
        resolved.outgoingClip.trackId,
        Math.max(outgoingZ, incomingZ),
      );
      zIndexOverrides.set(
        resolved.incomingClip.trackId,
        Math.min(outgoingZ, incomingZ),
      );
    }

    if (resolved.transition.type === "dipToColor") {
      const color =
        typeof resolved.transition.parameters.color === "string"
          ? resolved.transition.parameters.color
          : "#000000";
      colorLayers.push({
        id: resolved.transition.id,
        color,
        parentGroupId: sharedParent,
        zIndex: Math.min(outgoingZ, incomingZ) - 0.5,
      });
    }
  }

  return { transformsByClipId, zIndexOverrides, colorLayers };
}
