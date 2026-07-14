import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
  type RegisteredExtensionContribution,
} from "./ExtensionContributionRegistry";

export interface ExtensionLutDefinition extends ExtensionContributionDefinition {
  readonly apiVersion: 1;
  readonly label: string;
  readonly description?: string;
  readonly order: number;
  readonly resourceUrl: string;
  readonly packageVersion: string;
  readonly packageDigest: string;
}

export type RegisteredExtensionLut =
  RegisteredExtensionContribution<ExtensionLutDefinition>;

export class ExtensionLutRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<ExtensionLutDefinition>("lut");

  registerPackageLut(
    ownerId: string,
    definition: ExtensionLutDefinition,
  ) {
    if (definition.apiVersion !== 1) {
      throw new Error(`LUT contribution '${definition.id}' must use API 1.`);
    }
    if (!definition.label.trim()) {
      throw new Error(`LUT contribution '${definition.id}' must declare a label.`);
    }
    if (!Number.isFinite(definition.order)) {
      throw new Error(`LUT contribution '${definition.id}' order must be finite.`);
    }
    if (!definition.resourceUrl.trim()) {
      throw new Error(
        `LUT contribution '${definition.id}' must declare a resource URL.`,
      );
    }

    return this.registry.registerHostOwned(ownerId, {
      ...definition,
      label: definition.label.trim(),
      ...(definition.description?.trim()
        ? { description: definition.description.trim() }
        : {}),
      execution: "trusted",
    });
  }

  list(): readonly RegisteredExtensionLut[] {
    return [...this.registry.list()].sort(
      (left, right) =>
        left.definition.order - right.definition.order ||
        left.definition.label.localeCompare(right.definition.label) ||
        left.id.localeCompare(right.id),
    );
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener);
  }

  getRevision(): number {
    return this.registry.getRevision();
  }
}

export const extensionLutRegistry = new ExtensionLutRegistry();
