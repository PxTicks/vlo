import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionTrustedHostApi,
  ExtensionTrustedHostEntry,
} from "../types";
import { trustedHostPatchManager } from "./TrustedHostPatchManager";

export type TrustedHostEntryLifetime = "session" | "availability";

export interface TrustedHostEntryDefinition {
  readonly id: string;
  readonly lifetime: TrustedHostEntryLifetime;
  readonly getValue: () => unknown;
  readonly assertValue: (value: unknown) => boolean;
}

type TrustedHostEntryResolution =
  | { readonly status: "available"; readonly value: unknown }
  | { readonly status: "unavailable" }
  | {
      readonly status: "invalid";
      readonly message: string;
      readonly error: unknown;
    };

type TrustedHostDiagnosticReporter = (
  message: string,
  detail: unknown,
) => void;

const ENTRY_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class TrustedHostAccessDirectory {
  private readonly entries = new Map<string, TrustedHostEntryDefinition>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  register(definition: TrustedHostEntryDefinition): ExtensionDisposable {
    if (!ENTRY_ID_PATTERN.test(definition.id)) {
      throw new TypeError(`Invalid trusted host entry ID '${definition.id}'.`);
    }
    if (this.entries.has(definition.id)) {
      throw new Error(
        `Trusted host entry '${definition.id}' is already registered.`,
      );
    }
    this.entries.set(definition.id, Object.freeze({ ...definition }));
    this.publishChange();
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.entries.delete(definition.id);
        this.publishChange();
      },
    });
  }

  list(): readonly ExtensionTrustedHostEntry[] {
    return this.listWithDiagnostics();
  }

  get(id: string): unknown {
    return this.getWithDiagnostics(id);
  }

  private listWithDiagnostics(
    reportDiagnostic?: TrustedHostDiagnosticReporter,
  ): readonly ExtensionTrustedHostEntry[] {
    return Object.freeze(
      [...this.entries.values()].map((entry) => {
        const resolution = this.resolve(entry);
        if (resolution.status === "invalid") {
          reportDiagnostic?.(resolution.message, resolution.error);
        }
        return Object.freeze({
          id: entry.id,
          available: resolution.status === "available",
          lifetime: entry.lifetime,
        });
      }),
    );
  }

  private getWithDiagnostics(
    id: string,
    reportDiagnostic?: TrustedHostDiagnosticReporter,
  ): unknown {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const resolution = this.resolve(entry);
    if (resolution.status === "invalid") {
      reportDiagnostic?.(resolution.message, resolution.error);
    }
    return resolution.status === "available" ? resolution.value : undefined;
  }

  getRevision(): number {
    return this.revision;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyAvailabilityChanged(): void {
    this.publishChange();
  }

  bind(
    scope: ExtensionApiScope,
    hostVersion: string | null,
  ): ExtensionTrustedHostApi {
    let reportedUse = false;
    const markUsed = () => {
      if (reportedUse) return;
      reportedUse = true;
      scope.report("debug", "Trusted host access used.", { hostVersion });
    };
    const reportResolutionFailure: TrustedHostDiagnosticReporter = (
      message,
      detail,
    ) => scope.report("error", message, detail);
    return Object.freeze({
      hostVersion,
      list: () => {
        markUsed();
        return this.listWithDiagnostics(reportResolutionFailure);
      },
      get: (id: string) => {
        markUsed();
        return this.getWithDiagnostics(id, reportResolutionFailure);
      },
      require: (id: string) => {
        markUsed();
        const entry = this.entries.get(id);
        const resolution = entry
          ? this.resolve(entry)
          : { status: "unavailable" as const };
        if (resolution.status === "invalid") {
          reportResolutionFailure(resolution.message, resolution.error);
          throw new Error(
            `[Extension ${scope.extension.id}] ${resolution.message}`,
            { cause: resolution.error },
          );
        }
        if (resolution.status === "unavailable") {
          const message = `Trusted host entry '${id}' is unavailable in this VLO build or editor state.`;
          scope.report("error", message);
          throw new Error(`[Extension ${scope.extension.id}] ${message}`);
        }
        return resolution.value;
      },
      getRevision: () => {
        markUsed();
        return this.getRevision();
      },
      subscribe: (listener: () => void) => {
        markUsed();
        return this.subscribe(() => {
          try {
            listener();
          } catch (error) {
            scope.report(
              "error",
              "A trusted host availability listener failed.",
              error,
            );
          }
        });
      },
      patchProperty: (
        target: object,
        property: PropertyKey,
        createDescriptor: (
          previous: PropertyDescriptor | undefined,
        ) => PropertyDescriptor,
      ) => {
        markUsed();
        return trustedHostPatchManager.patchProperty(
          scope,
          target,
          property,
          createDescriptor,
        );
      },
    });
  }

  private resolve(entry: TrustedHostEntryDefinition): TrustedHostEntryResolution {
    let value: unknown;
    try {
      value = entry.getValue();
    } catch (error) {
      return {
        status: "invalid",
        message: `Trusted host entry '${entry.id}' failed while resolving its host value.`,
        error,
      };
    }
    if (value === undefined || value === null) return { status: "unavailable" };

    try {
      if (entry.assertValue(value)) {
        return { status: "available", value };
      }
    } catch (error) {
      return {
        status: "invalid",
        message: `Trusted host entry '${entry.id}' failed its host shape assertion.`,
        error,
      };
    }

    const error = new TypeError(
      `Trusted host entry '${entry.id}' failed its host shape assertion.`,
    );
    return { status: "invalid", message: error.message, error };
  }

  private publishChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export const trustedHostAccessDirectory = new TrustedHostAccessDirectory();
