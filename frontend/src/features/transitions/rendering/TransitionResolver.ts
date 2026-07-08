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
import { findTransitionDefinition } from "../catalogue/TransitionRegistry";
import type { TransitionFrameResult, TransitionZOrder } from "../catalogue/types";
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

function resolveZOrder(
  frame: TransitionFrameResult,
  definition: NonNullable<ReturnType<typeof findTransitionDefinition>>,
): TransitionZOrder {
  if (frame.zOrder) return frame.zOrder;
  if (definition.zOrder) return definition.zOrder;
  if (definition.hijackZOrder) return "outgoing-on-top";
  return "default";
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
  const transformsByClipId = new Map<string, readonly ClipTransform[]>();
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
    const definition = findTransitionDefinition(resolved.transition.type);
    if (!definition) continue;

    const progress = resolveTransitionProgress(
      resolved,
      options.presentationTick,
    );
    const transitionFrame =
      definition.renderFrame?.({
        transition: resolved.transition,
        outgoingClip: resolved.outgoingClip,
        incomingClip: resolved.incomingClip,
        progress,
        startTick: resolved.start,
        endTick: resolved.end,
        durationTicks: resolved.duration,
        presentationTick: options.presentationTick,
        fps: options.fps,
        logicalDimensions: options.logicalDimensions,
      }) ?? {
        outgoingTransforms: buildTransitionTransforms(
          resolved.transition,
          "outgoing",
          progress,
          options.logicalDimensions,
        ),
        incomingTransforms: buildTransitionTransforms(
          resolved.transition,
          "incoming",
          progress,
          options.logicalDimensions,
        ),
      };
    transformsByClipId.set(
      resolved.outgoingClip.id,
      transitionFrame.outgoingTransforms ?? [],
    );
    transformsByClipId.set(
      resolved.incomingClip.id,
      transitionFrame.incomingTransforms ?? [],
    );

    const outgoingParent =
      parentGroupByTrack.get(resolved.outgoingClip.trackId) ?? null;
    const incomingParent =
      parentGroupByTrack.get(resolved.incomingClip.trackId) ?? null;
    const sharedParent =
      outgoingParent === incomingParent ? outgoingParent : null;

    const outgoingZ = baseZByTrack.get(resolved.outgoingClip.trackId) ?? 0;
    const incomingZ = baseZByTrack.get(resolved.incomingClip.trackId) ?? 0;
    const zOrder = resolveZOrder(transitionFrame, definition);
    if (outgoingParent === incomingParent && zOrder === "outgoing-on-top") {
      zIndexOverrides.set(
        resolved.outgoingClip.trackId,
        Math.max(outgoingZ, incomingZ),
      );
      zIndexOverrides.set(
        resolved.incomingClip.trackId,
        Math.min(outgoingZ, incomingZ),
      );
    }
    if (outgoingParent === incomingParent && zOrder === "incoming-on-top") {
      zIndexOverrides.set(
        resolved.outgoingClip.trackId,
        Math.min(outgoingZ, incomingZ),
      );
      zIndexOverrides.set(
        resolved.incomingClip.trackId,
        Math.max(outgoingZ, incomingZ),
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
    for (const layer of transitionFrame.colorLayers ?? []) {
      colorLayers.push({
        id: layer.id ?? `${resolved.transition.id}:color`,
        color: layer.color,
        parentGroupId: sharedParent,
        zIndex:
          Math.min(outgoingZ, incomingZ) - 0.5 + (layer.zIndexOffset ?? 0),
      });
    }
  }

  return { transformsByClipId, zIndexOverrides, colorLayers };
}
