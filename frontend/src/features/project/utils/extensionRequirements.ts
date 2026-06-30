import {
  collectProjectExtensionRequirements,
  extensionPayloadProviderRegistry,
  type ExtensionProviderAvailabilityResolver,
  type ProjectExtensionRequirement,
} from "../../extensions/persistence/publicApi";
import type { TimelineClip } from "../../../types/TimelineTypes";
import type { ExtensionPayload } from "../../extensions/types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isExtensionSpatialPathParameter,
} from "../../transformations/types";
import {
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
  extensionSpatialPathRegistry,
} from "../../transformations/animation";

function contributionAvailability(
  payload: ExtensionPayload,
  contribution:
    | Readonly<{
        definition: Readonly<{
          schemaVersion: number;
          migrate?: unknown;
        }>;
      }>
    | undefined,
): "available" | "missing" | "incompatible" {
  if (!contribution) return "missing";
  if (payload.schemaVersion > contribution.definition.schemaVersion) {
    return "incompatible";
  }
  if (
    payload.schemaVersion < contribution.definition.schemaVersion &&
    typeof contribution.definition.migrate !== "function"
  ) {
    return "incompatible";
  }
  return "available";
}

interface CollectedSource {
  readonly entityId: string;
  readonly payload: ExtensionPayload;
  readonly availability: "available" | "missing" | "incompatible";
}

function collectAnimationSources(
  value: unknown,
  entityId: string,
  output: CollectedSource[],
  visited: WeakSet<object>,
): void {
  if (typeof value !== "object" || value === null) return;
  if (visited.has(value)) return;
  visited.add(value);

  if (isExtensionScalarSourceParameter(value)) {
    output.push({
      entityId,
      payload: value.source,
      availability: contributionAvailability(
        value.source,
        extensionScalarSourceRegistry.get(value.source),
      ),
    });
    return;
  }
  if (isExtensionKeyframedScalarParameter(value)) {
    value.keyframes.forEach((keyframe, index) => {
      if (!keyframe.outgoing) return;
      output.push({
        entityId: `${entityId}:segment-${index}`,
        payload: keyframe.outgoing,
        availability: contributionAvailability(
          keyframe.outgoing,
          extensionInterpolationRegistry.get(keyframe.outgoing),
        ),
      });
    });
    return;
  }
  if (isExtensionSpatialPathParameter(value)) {
    output.push({
      entityId,
      payload: value.geometry,
      availability: contributionAvailability(
        value.geometry,
        extensionSpatialPathRegistry.get(value.geometry),
      ),
    });
    collectAnimationSources(value.timing, `${entityId}:timing`, output, visited);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectAnimationSources(entry, `${entityId}:${index}`, output, visited),
    );
    return;
  }
  Object.entries(value).forEach(([key, entry]) =>
    collectAnimationSources(entry, `${entityId}:${key}`, output, visited),
  );
}

export function collectTimelineExtensionRequirements(
  clips: readonly TimelineClip[],
  resolveAvailability: ExtensionProviderAvailabilityResolver = (payload) =>
    extensionPayloadProviderRegistry.getAvailability(payload),
): ProjectExtensionRequirement[] {
  const sources: CollectedSource[] = [];
  clips.forEach((clip) => {
    if (clip.type === "extension") {
      sources.push({
        entityId: clip.id,
        payload: clip.extensionPayload,
        availability: resolveAvailability(clip.extensionPayload),
      });
    }
    clip.transformations?.forEach((transform) => {
      collectAnimationSources(
        transform.parameters,
        `${clip.id}:${transform.id}`,
        sources,
        new WeakSet(),
      );
    });
  });
  const availability = new WeakMap<object, CollectedSource["availability"]>();
  sources.forEach((source) => availability.set(source.payload, source.availability));
  return collectProjectExtensionRequirements(
    sources,
    (payload) => availability.get(payload) ?? resolveAvailability(payload),
  );
}
