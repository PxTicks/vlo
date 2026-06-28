import {
  collectProjectExtensionRequirements,
  extensionPayloadProviderRegistry,
  type ExtensionProviderAvailabilityResolver,
  type ProjectExtensionRequirement,
} from "../../extensions/persistence/publicApi";
import type { TimelineClip } from "../../../types/TimelineTypes";

export function collectTimelineExtensionRequirements(
  clips: readonly TimelineClip[],
  resolveAvailability: ExtensionProviderAvailabilityResolver = (payload) =>
    extensionPayloadProviderRegistry.getAvailability(payload),
): ProjectExtensionRequirement[] {
  const sources = clips.flatMap((clip) =>
    clip.type === "extension"
      ? [{ entityId: clip.id, payload: clip.extensionPayload }]
      : [],
  );
  return collectProjectExtensionRequirements(sources, resolveAvailability);
}
