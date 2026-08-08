import type {
  ExtensionApiScope,
  ExtensionPeerApi,
  ExtensionPeerSnapshot,
} from "../types";

/** What one package declared about itself, as read from its manifest. */
export interface ExtensionPackageDeclaration {
  readonly id: string;
  readonly version: string;
  /** Peer ID to declared version range. */
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface ExtensionPeerRegistration {
  dispose(): void;
}

/**
 * Who depends on whom, and what each package exported.
 *
 * This is deliberately not a shared host seam: dependency declaration, package
 * identity, and an activation-scoped export channel exist only because an
 * extension owns them, so per the dogfooding plan's §2.4 they stay
 * conformance-tested rather than pretending to have a native consumer.
 *
 * The registry holds two facts that arrive at different times — the manifest's
 * declarations, published by the runtime before activation, and the exported
 * API, published by the host only after activation succeeds.
 */
export class ExtensionPeerRegistry {
  private readonly declarations = new Map<string, ExtensionPackageDeclaration>();
  private readonly exports = new Map<string, object>();
  private readonly active = new Set<string>();

  /**
   * Records one package's manifest facts. Replacing an existing declaration is
   * allowed — the inventory is re-read on reload — but never touches exports,
   * which belong to the activation rather than to the manifest.
   */
  declarePackage(
    declaration: ExtensionPackageDeclaration,
  ): ExtensionPeerRegistration {
    const frozen: ExtensionPackageDeclaration = Object.freeze({
      id: declaration.id,
      version: declaration.version,
      dependencies: Object.freeze({ ...declaration.dependencies }),
    });
    this.declarations.set(frozen.id, frozen);
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.declarations.get(frozen.id) !== frozen) return;
        this.declarations.delete(frozen.id);
      },
    });
  }

  getDeclaration(extensionId: string): ExtensionPackageDeclaration | undefined {
    return this.declarations.get(extensionId);
  }

  /** Host-only, called once an activation has actually completed. */
  publishApi(extensionId: string, api: object): void {
    this.exports.set(extensionId, api);
    this.active.add(extensionId);
  }

  /** Host-only. Marks the package active without an exported API. */
  markActive(extensionId: string): void {
    this.active.add(extensionId);
  }

  /** Host-only, called as the package deactivates or its activation fails. */
  retract(extensionId: string): void {
    this.exports.delete(extensionId);
    this.active.delete(extensionId);
  }

  isActive(extensionId: string): boolean {
    return this.active.has(extensionId);
  }

  getApi(extensionId: string): object | undefined {
    return this.exports.get(extensionId);
  }

  /** Test/lifecycle seam; a page reload is the production equivalent. */
  reset(): void {
    this.declarations.clear();
    this.exports.clear();
    this.active.clear();
  }

  /**
   * Owner-scoped `api.extensions`. Reads are gated on the caller's *declared*
   * dependencies rather than on what happens to be installed: an undeclared
   * peer is a missing manifest entry, which is the extension's mistake, so it
   * throws instead of resolving to nothing.
   */
  bind(scope: ExtensionApiScope): ExtensionPeerApi {
    const ownerId = scope.extension.id;
    const dependenciesOf = (): Readonly<Record<string, string>> =>
      this.declarations.get(ownerId)?.dependencies ?? {};

    const assertDeclared = (extensionId: string): string => {
      if (typeof extensionId !== "string" || extensionId.length === 0) {
        throw new TypeError("A peer extension ID must be a non-empty string.");
      }
      const range = dependenciesOf()[extensionId];
      if (range === undefined) {
        throw new Error(
          `Extension '${ownerId}' did not declare '${extensionId}' as a ` +
            `dependency. Add it to the manifest's dependencies.`,
        );
      }
      return range;
    };

    return Object.freeze({
      listDependencies: (): readonly ExtensionPeerSnapshot[] =>
        Object.freeze(
          Object.entries(dependenciesOf()).map(([id, versionRange]) =>
            Object.freeze({
              id,
              version: this.declarations.get(id)?.version ?? "",
              versionRange,
              isActive: this.active.has(id),
              hasApi: this.exports.has(id),
            }),
          ),
        ),
      getApi: (extensionId: string): unknown => {
        assertDeclared(extensionId);
        return this.exports.get(extensionId);
      },
      requireApi: (extensionId: string): unknown => {
        assertDeclared(extensionId);
        const api = this.exports.get(extensionId);
        if (api === undefined) {
          throw new Error(
            `Extension '${extensionId}' has not exported an API. It is ` +
              `${this.active.has(extensionId) ? "active but exports nothing" : "not active"}.`,
          );
        }
        return api;
      },
    });
  }
}

export const extensionPeerRegistry = new ExtensionPeerRegistry();
