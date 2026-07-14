import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionExecutionMode,
} from "../types";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export interface ExtensionContributionDefinition {
  id: string;
  apiVersion: number;
  execution?: ExtensionExecutionMode;
}

export interface RegisteredExtensionContribution<
  TDefinition extends ExtensionContributionDefinition,
> {
  id: string;
  localId: string;
  ownerId: string;
  registryKind: string;
  /**
   * A shallow-frozen snapshot. Domain registries remain responsible for
   * validating and defensively copying/freezing nested configuration objects.
   */
  definition: Readonly<TDefinition>;
}

export interface ExtensionContributionRegistration<
  TDefinition extends ExtensionContributionDefinition,
> extends ExtensionDisposable {
  readonly id: string;
  readonly contribution: RegisteredExtensionContribution<TDefinition>;
}

export interface BoundExtensionContributionRegistry<
  TDefinition extends ExtensionContributionDefinition,
> {
  register(
    definition: TDefinition,
  ): ExtensionContributionRegistration<TDefinition>;
}

export class InvalidExtensionContributionIdError extends Error {
  constructor(label: string, id: string) {
    super(
      `Invalid ${label} '${id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
    this.name = "InvalidExtensionContributionIdError";
  }
}

export class DuplicateExtensionContributionError extends Error {
  readonly contributionId: string;
  readonly registryKind: string;

  constructor(registryKind: string, contributionId: string) {
    super(
      `Contribution '${contributionId}' is already registered in '${registryKind}'.`,
    );
    this.name = "DuplicateExtensionContributionError";
    this.contributionId = contributionId;
    this.registryKind = registryKind;
  }
}

function assertValidId(label: string, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new InvalidExtensionContributionIdError(label, id);
  }
}

function createContributionId(ownerId: string, localId: string): string {
  return `${ownerId}/${localId}`;
}

export class ExtensionContributionRegistry<
  TDefinition extends ExtensionContributionDefinition,
> {
  readonly kind: string;

  private readonly contributions = new Map<
    string,
    RegisteredExtensionContribution<TDefinition>
  >();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(kind: string) {
    assertValidId("registry kind", kind);
    this.kind = kind;
  }

  /**
   * Creates the registrar exposed by a host-built Extension API. The facade
   * injects the activation owner and enrolls every registration for rollback
   * and deactivation; extensions must never receive the raw registry instance.
   */
  bind(scope: ExtensionApiScope): BoundExtensionContributionRegistry<TDefinition> {
    return Object.freeze({
      register: (definition: TDefinition) =>
        scope.own(this.registerForOwner(scope.extension.id, definition)),
    });
  }

  /**
   * Host adapters use this for approved declarative manifest contributions.
   * The caller must enroll the returned registration in the package activation
   * scope; this method is never exposed through the extension API.
   */
  registerHostOwned(
    ownerId: string,
    definition: TDefinition,
  ): ExtensionContributionRegistration<TDefinition> {
    return this.registerForOwner(ownerId, definition);
  }

  private registerForOwner(
    ownerId: string,
    definition: TDefinition,
  ): ExtensionContributionRegistration<TDefinition> {
    assertValidId("extension ID", ownerId);
    assertValidId("contribution ID", definition.id);

    if (!Number.isInteger(definition.apiVersion) || definition.apiVersion < 1) {
      throw new Error(
        `Contribution '${definition.id}' must declare a positive integer apiVersion.`,
      );
    }

    const id = createContributionId(ownerId, definition.id);
    if (this.contributions.has(id)) {
      throw new DuplicateExtensionContributionError(this.kind, id);
    }

    const contribution: RegisteredExtensionContribution<TDefinition> =
      Object.freeze({
        id,
        localId: definition.id,
        ownerId,
        registryKind: this.kind,
        definition: Object.freeze({ ...definition }) as Readonly<TDefinition>,
      });

    this.contributions.set(id, contribution);
    this.emitChange();

    let isDisposed = false;
    return Object.freeze({
      id,
      contribution,
      dispose: () => {
        if (isDisposed) return;
        isDisposed = true;
        if (this.contributions.delete(id)) {
          this.emitChange();
        }
      },
    });
  }

  get(id: string): RegisteredExtensionContribution<TDefinition> | undefined {
    return this.contributions.get(id);
  }

  has(id: string): boolean {
    return this.contributions.has(id);
  }

  list(): readonly RegisteredExtensionContribution<TDefinition>[] {
    return [...this.contributions.values()];
  }

  listByOwner(
    ownerId: string,
  ): readonly RegisteredExtensionContribution<TDefinition>[] {
    return this.list().filter(
      (contribution) => contribution.ownerId === ownerId,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Registry observers are derived UI/cache notifications and must not
        // interfere with contribution registration or disposal.
      }
    }
  }
}
