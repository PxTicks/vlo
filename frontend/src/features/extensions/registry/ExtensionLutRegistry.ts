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

export interface ExtensionLutProjectionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly order: number;
  readonly resourceUrl: string;
}

export interface ExtensionLutPackageProjection {
  readonly ownerId: string;
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly luts: readonly ExtensionLutProjectionDefinition[];
}

export interface ExtensionLutProjectionFailure {
  readonly ownerId: string;
  readonly packageDigest: string;
  readonly error: unknown;
}

export class ExtensionLutRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<ExtensionLutDefinition>("lut");
  private readonly projectedPackageDigests = new Map<string, string>();

  private normalizeDefinition(
    projection: ExtensionLutPackageProjection,
    definition: ExtensionLutProjectionDefinition,
  ): ExtensionLutDefinition {
    const label = definition.label.trim();
    const description = definition.description?.trim();
    if (!label) {
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

    return {
      id: definition.id,
      apiVersion: 1,
      label,
      ...(description ? { description } : {}),
      order: definition.order,
      resourceUrl: definition.resourceUrl.trim(),
      packageVersion: projection.packageVersion,
      packageDigest: projection.packageDigest,
    };
  }

  /**
   * Reconciles approved manifest projections one package at a time. Each
   * package replacement is assembled and validated before the common registry
   * swaps its owner-qualified entries and emits a single revision.
   */
  reconcilePackages(
    projections: readonly ExtensionLutPackageProjection[],
  ): readonly ExtensionLutProjectionFailure[] {
    const failures: ExtensionLutProjectionFailure[] = [];
    const nextByOwner = new Map<string, ExtensionLutPackageProjection>();
    const duplicateOwners = new Set<string>();
    for (const projection of projections) {
      if (nextByOwner.has(projection.ownerId)) {
        duplicateOwners.add(projection.ownerId);
        nextByOwner.delete(projection.ownerId);
        continue;
      }
      if (!duplicateOwners.has(projection.ownerId)) {
        nextByOwner.set(projection.ownerId, projection);
      }
    }

    for (const ownerId of this.projectedPackageDigests.keys()) {
      if (!nextByOwner.has(ownerId)) {
        this.registry.replaceForOwner(ownerId, []);
        this.projectedPackageDigests.delete(ownerId);
      }
    }

    for (const ownerId of duplicateOwners) {
      failures.push({
        ownerId,
        packageDigest: "",
        error: new Error(
          `Inventory contains more than one LUT projection for '${ownerId}'.`,
        ),
      });
    }

    for (const projection of nextByOwner.values()) {
      if (
        this.projectedPackageDigests.get(projection.ownerId) ===
        projection.packageDigest
      ) {
        continue;
      }

      try {
        if (!projection.packageVersion.trim()) {
          throw new Error(
            `LUT package '${projection.ownerId}' must declare a version.`,
          );
        }
        if (!projection.packageDigest.trim()) {
          throw new Error(
            `LUT package '${projection.ownerId}' must declare a digest.`,
          );
        }
        const definitions = projection.luts.map((definition) =>
          this.normalizeDefinition(projection, definition),
        );
        this.registry.replaceForOwner(projection.ownerId, definitions);
        this.projectedPackageDigests.set(
          projection.ownerId,
          projection.packageDigest,
        );
      } catch (error) {
        try {
          this.registry.replaceForOwner(projection.ownerId, []);
        } catch {
          // An invalid owner cannot have an earlier valid projection to clear.
        }
        this.projectedPackageDigests.delete(projection.ownerId);
        failures.push({
          ownerId: projection.ownerId,
          packageDigest: projection.packageDigest,
          error,
        });
      }
    }

    return Object.freeze(failures);
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
