import type { ExtensionPayload } from "../types";

export type ExtensionProviderAvailability =
  | "available"
  | "missing"
  | "incompatible";

export interface ExtensionRequirementSource {
  entityId: string;
  payload: ExtensionPayload;
}

export interface ProjectExtensionRequirement {
  id: string;
  extensionId: string;
  typeId: string;
  schemaVersions: number[];
  entityIds: string[];
  availability: ExtensionProviderAvailability;
}

export type ExtensionProviderAvailabilityResolver = (
  payload: ExtensionPayload,
) => ExtensionProviderAvailability;

interface MutableRequirement {
  extensionId: string;
  typeId: string;
  schemaVersions: Set<number>;
  entityIds: Set<string>;
  availability: ExtensionProviderAvailability;
}

const AVAILABILITY_PRIORITY: Record<ExtensionProviderAvailability, number> = {
  available: 0,
  missing: 1,
  incompatible: 2,
};

export function getExtensionPayloadProviderId(
  payload: Pick<ExtensionPayload, "extensionId" | "typeId">,
): string {
  return `${payload.extensionId}/${payload.typeId}`;
}

export function collectProjectExtensionRequirements(
  sources: readonly ExtensionRequirementSource[],
  resolveAvailability: ExtensionProviderAvailabilityResolver = () => "missing",
): ProjectExtensionRequirement[] {
  const requirements = new Map<string, MutableRequirement>();

  for (const source of sources) {
    const id = getExtensionPayloadProviderId(source.payload);
    const availability = resolveAvailability(source.payload);
    const existing = requirements.get(id);
    if (existing) {
      existing.schemaVersions.add(source.payload.schemaVersion);
      existing.entityIds.add(source.entityId);
      if (
        AVAILABILITY_PRIORITY[availability] >
        AVAILABILITY_PRIORITY[existing.availability]
      ) {
        existing.availability = availability;
      }
      continue;
    }

    requirements.set(id, {
      extensionId: source.payload.extensionId,
      typeId: source.payload.typeId,
      schemaVersions: new Set([source.payload.schemaVersion]),
      entityIds: new Set([source.entityId]),
      availability,
    });
  }

  return [...requirements.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, requirement]) => ({
      id,
      extensionId: requirement.extensionId,
      typeId: requirement.typeId,
      schemaVersions: [...requirement.schemaVersions].sort(
        (left, right) => left - right,
      ),
      entityIds: [...requirement.entityIds].sort(),
      availability: requirement.availability,
    }));
}
