import type {
  ExtensionActivationState,
  ExtensionApiFactory,
  ExtensionApiScope,
  ExtensionCleanup,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionDiagnosticLevel,
  ExtensionDiagnosticPhase,
  ExtensionDisposable,
  ExtensionIdentity,
  ExtensionLogger,
  ExtensionModule,
  ExtensionResource,
} from "./types";

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DIAGNOSTICS = 500;

type ExtensionCancellationReason = "deactivation" | "timeout";

interface ActiveExtensionSession {
  identity: Readonly<ExtensionIdentity>;
  abortController: AbortController;
  resources: ExtensionResource[];
  resourceSet: Set<ExtensionResource>;
  acceptingResources: boolean;
  cancellationReason?: ExtensionCancellationReason;
  activationPromise?: Promise<void>;
  cleanupPromise?: Promise<unknown[]>;
  deactivationPromise?: Promise<boolean>;
}

export interface ExtensionHostOptions<TApi extends object> {
  sdkVersion: string;
  /** Application/build version, distinct from the extension SDK version. */
  hostVersion?: string | null;
  createApi: ExtensionApiFactory<TApi>;
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  now?: () => number;
  /** Use `null` to disable the activation timeout. */
  activationTimeoutMs?: number | null;
  /** Retained in-memory diagnostics. The callback still receives entries at 0. */
  maxDiagnostics?: number;
}

export class InvalidExtensionIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExtensionIdentityError";
  }
}

export class InvalidExtensionResourceError extends TypeError {
  constructor() {
    super("Extension resources must be cleanup functions or objects with dispose().");
    this.name = "InvalidExtensionResourceError";
  }
}

export class ExtensionRegistrationClosedError extends Error {
  readonly extensionId: string;

  constructor(extensionId: string) {
    super(`Extension '${extensionId}' can no longer register resources.`);
    this.name = "ExtensionRegistrationClosedError";
    this.extensionId = extensionId;
  }
}

export class ExtensionLifecycleStateError extends Error {
  readonly extensionId: string;
  readonly status: ExtensionActivationState["status"];

  constructor(extensionId: string, status: ExtensionActivationState["status"]) {
    super(`Extension '${extensionId}' cannot activate while it is '${status}'.`);
    this.name = "ExtensionLifecycleStateError";
    this.extensionId = extensionId;
    this.status = status;
  }
}

export class ExtensionActivationError extends Error {
  readonly extensionId: string;

  constructor(extensionId: string, cause: unknown) {
    super(`Failed to activate extension '${extensionId}'.`, { cause });
    this.name = "ExtensionActivationError";
    this.extensionId = extensionId;
  }
}

export class ExtensionActivationCancelledError extends Error {
  readonly extensionId: string;

  constructor(extensionId: string, cause?: unknown) {
    super(`Activation of extension '${extensionId}' was cancelled.`, { cause });
    this.name = "ExtensionActivationCancelledError";
    this.extensionId = extensionId;
  }
}

export class ExtensionActivationTimeoutError extends Error {
  readonly extensionId: string;
  readonly timeoutMs: number;

  constructor(extensionId: string, timeoutMs: number) {
    super(`Extension '${extensionId}' did not activate within ${timeoutMs}ms.`);
    this.name = "ExtensionActivationTimeoutError";
    this.extensionId = extensionId;
    this.timeoutMs = timeoutMs;
  }
}

export class ExtensionDeactivationError extends AggregateError {
  readonly extensionId: string;

  constructor(extensionId: string, errors: unknown[]) {
    super(errors, `Failed to fully deactivate extension '${extensionId}'.`);
    this.name = "ExtensionDeactivationError";
    this.extensionId = extensionId;
  }
}

function assertValidIdentity(identity: ExtensionIdentity): void {
  if (!EXTENSION_ID_PATTERN.test(identity.id)) {
    throw new InvalidExtensionIdentityError(
      `Invalid extension ID '${identity.id}'. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  if (!identity.version.trim()) {
    throw new InvalidExtensionIdentityError(
      `Extension '${identity.id}' must declare a version.`,
    );
  }
}

function isDisposable(
  resource: ExtensionResource,
): resource is ExtensionDisposable {
  return (
    typeof resource === "object" &&
    resource !== null &&
    typeof resource.dispose === "function"
  );
}

function assertExtensionResource(resource: unknown): asserts resource is ExtensionResource {
  if (
    typeof resource !== "function" &&
    !(
      typeof resource === "object" &&
      resource !== null &&
      "dispose" in resource &&
      typeof resource.dispose === "function"
    )
  ) {
    throw new InvalidExtensionResourceError();
  }
}

async function disposeResource(resource: ExtensionResource): Promise<void> {
  if (isDisposable(resource)) {
    await resource.dispose();
    return;
  }

  const cleanup: ExtensionCleanup = resource;
  await cleanup();
}

function validateActivationTimeout(timeoutMs: number | null): void {
  if (
    timeoutMs !== null &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new RangeError("activationTimeoutMs must be positive or null.");
  }
}

function validateMaxDiagnostics(maxDiagnostics: number): void {
  if (!Number.isInteger(maxDiagnostics) || maxDiagnostics < 0) {
    throw new RangeError("maxDiagnostics must be a non-negative integer.");
  }
}

export class ExtensionHost<TApi extends object = Record<string, never>> {
  private readonly sdkVersion: string;
  private readonly hostVersion: string | null | undefined;
  private readonly createApi: ExtensionApiFactory<TApi>;
  private readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  private readonly now: () => number;
  private readonly activationTimeoutMs: number | null;
  private readonly maxDiagnostics: number;
  private readonly sessions = new Map<string, ActiveExtensionSession>();
  private readonly states = new Map<string, ExtensionActivationState>();
  private readonly diagnostics: ExtensionDiagnostic[] = [];
  private readonly activationOrder: string[] = [];

  constructor(options: ExtensionHostOptions<TApi>) {
    const activationTimeoutMs =
      options.activationTimeoutMs === undefined
        ? DEFAULT_ACTIVATION_TIMEOUT_MS
        : options.activationTimeoutMs;
    const maxDiagnostics =
      options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS;
    validateActivationTimeout(activationTimeoutMs);
    validateMaxDiagnostics(maxDiagnostics);

    this.sdkVersion = options.sdkVersion;
    this.hostVersion = options.hostVersion;
    this.createApi = options.createApi;
    this.onDiagnostic = options.onDiagnostic;
    this.now = options.now ?? Date.now;
    this.activationTimeoutMs = activationTimeoutMs;
    this.maxDiagnostics = maxDiagnostics;
  }

  async activate(
    identity: ExtensionIdentity,
    extensionModule: ExtensionModule<TApi>,
  ): Promise<void> {
    assertValidIdentity(identity);

    const currentState = this.states.get(identity.id);
    if (
      currentState?.status === "active" ||
      currentState?.status === "activating" ||
      currentState?.status === "deactivating"
    ) {
      throw new ExtensionLifecycleStateError(identity.id, currentState.status);
    }

    const frozenIdentity = Object.freeze({ ...identity });
    const session: ActiveExtensionSession = {
      identity: frozenIdentity,
      abortController: new AbortController(),
      resources: [],
      resourceSet: new Set(),
      acceptingResources: true,
    };

    this.sessions.set(identity.id, session);
    this.setState(frozenIdentity, "activating");
    this.report(identity.id, "info", "activation", "Activation started.");

    const activationPromise = this.runActivation(session, extensionModule);
    session.activationPromise = activationPromise;
    await activationPromise;
  }

  async deactivate(extensionId: string): Promise<boolean> {
    const session = this.sessions.get(extensionId);
    if (!session) return false;

    if (!session.deactivationPromise) {
      session.deactivationPromise = this.deactivateSession(session);
    }
    return session.deactivationPromise;
  }

  async deactivateAll(): Promise<void> {
    const pendingIds = [...this.sessions.keys()].filter(
      (extensionId) => !this.activationOrder.includes(extensionId),
    );
    const extensionIds = [...this.activationOrder, ...pendingIds].reverse();
    const errors: unknown[] = [];

    for (const extensionId of extensionIds) {
      try {
        await this.deactivate(extensionId);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to fully deactivate extensions.");
    }
  }

  getState(extensionId: string): ExtensionActivationState | undefined {
    const state = this.states.get(extensionId);
    return state ? { ...state } : undefined;
  }

  listStates(): readonly ExtensionActivationState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  getDiagnostics(extensionId?: string): readonly ExtensionDiagnostic[] {
    const diagnostics = extensionId
      ? this.diagnostics.filter(
          (diagnostic) => diagnostic.extensionId === extensionId,
        )
      : this.diagnostics;
    return diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  getHostVersion(): string | null | undefined {
    return this.hostVersion;
  }

  private async runActivation(
    session: ActiveExtensionSession,
    extensionModule: ExtensionModule<TApi>,
  ): Promise<void> {
    const { identity } = session;
    const own = <TResource extends ExtensionResource>(
      resource: TResource,
    ): TResource => {
      assertExtensionResource(resource);

      if (!session.acceptingResources) {
        void disposeResource(resource).catch((error) => {
          this.report(
            identity.id,
            "error",
            "deactivation",
            "A late extension resource failed to dispose.",
            error,
          );
        });
        throw new ExtensionRegistrationClosedError(identity.id);
      }

      if (!session.resourceSet.has(resource)) {
        session.resourceSet.add(resource);
        session.resources.push(resource);
      }
      return resource;
    };

    const scope: ExtensionApiScope = Object.freeze({
      extension: identity,
      signal: session.abortController.signal,
      ...(this.hostVersion === undefined
        ? {}
        : { hostVersion: this.hostVersion }),
      own,
      report: (
        level: ExtensionDiagnosticLevel,
        message: string,
        detail?: unknown,
      ) => this.report(identity.id, level, "runtime", message, detail),
    });

    const logger = this.createLogger(identity.id);

    try {
      const api = Object.freeze(this.createApi(scope));
      const context: ExtensionContext<TApi> = Object.freeze({
        extension: identity,
        sdkVersion: this.sdkVersion,
        signal: session.abortController.signal,
        api,
        logger,
        onDispose: own,
      });

      const moduleActivation = Promise.resolve()
        .then(() => extensionModule.activate(context))
        .then((activationResource) => {
          if (activationResource) {
            own(activationResource);
          }
        });

      await this.waitForActivation(session, moduleActivation);

      if (session.abortController.signal.aborted) {
        throw new ExtensionActivationCancelledError(identity.id);
      }

      this.activationOrder.push(identity.id);
      this.setState(identity, "active");
      this.report(identity.id, "info", "activation", "Activation completed.");
    } catch (error) {
      session.acceptingResources = false;
      session.abortController.abort();
      await this.cleanupSession(session, "activation");
      this.deleteSession(session);

      if (session.cancellationReason === "deactivation") {
        const cancellationError = new ExtensionActivationCancelledError(
          identity.id,
          error,
        );
        this.setState(identity, "inactive");
        this.report(
          identity.id,
          "info",
          "activation",
          "Activation was cancelled and registered resources were rolled back.",
        );
        throw cancellationError;
      }

      this.setState(identity, "failed", error);
      this.report(
        identity.id,
        "error",
        "activation",
        "Activation failed and registered resources were rolled back.",
        error,
      );
      throw new ExtensionActivationError(identity.id, error);
    }
  }

  private async deactivateSession(
    session: ActiveExtensionSession,
  ): Promise<boolean> {
    const { identity } = session;
    const wasActivating =
      this.states.get(identity.id)?.status === "activating";

    this.setState(identity, "deactivating");
    this.report(identity.id, "info", "deactivation", "Deactivation started.");
    session.acceptingResources = false;
    session.cancellationReason = "deactivation";
    session.abortController.abort();

    if (wasActivating && session.activationPromise) {
      try {
        await session.activationPromise;
      } catch (error) {
        if (!(error instanceof ExtensionActivationCancelledError)) {
          this.report(
            identity.id,
            "warning",
            "deactivation",
            "Activation failed while deactivation was waiting for it.",
            error,
          );
        }
      }

      this.report(
        identity.id,
        "info",
        "deactivation",
        "Deactivation completed during activation.",
      );
      return true;
    }

    const errors = await this.cleanupSession(session, "deactivation");
    this.deleteSession(session);

    if (errors.length > 0) {
      const error = new ExtensionDeactivationError(identity.id, errors);
      this.setState(identity, "failed", error);
      this.report(
        identity.id,
        "error",
        "deactivation",
        "Deactivation completed with cleanup errors.",
        error,
      );
      throw error;
    }

    this.setState(identity, "inactive");
    this.report(identity.id, "info", "deactivation", "Deactivation completed.");
    return true;
  }

  private waitForActivation(
    session: ActiveExtensionSession,
    activation: Promise<void>,
  ): Promise<void> {
    if (this.activationTimeoutMs === null) {
      return activation;
    }

    const timeoutMs = this.activationTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        session.cancellationReason ??= "timeout";
        session.abortController.abort();
        reject(new ExtensionActivationTimeoutError(session.identity.id, timeoutMs));
      }, timeoutMs);

      activation.then(
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private cleanupSession(
    session: ActiveExtensionSession,
    phase: ExtensionDiagnosticPhase,
  ): Promise<unknown[]> {
    if (!session.cleanupPromise) {
      session.acceptingResources = false;
      session.cleanupPromise = this.disposeResources(
        session.identity.id,
        session.resources,
        phase,
      );
    }
    return session.cleanupPromise;
  }

  private deleteSession(session: ActiveExtensionSession): void {
    if (this.sessions.get(session.identity.id) === session) {
      this.sessions.delete(session.identity.id);
    }

    const orderIndex = this.activationOrder.lastIndexOf(session.identity.id);
    if (orderIndex >= 0) {
      this.activationOrder.splice(orderIndex, 1);
    }
  }

  private setState(
    identity: Readonly<ExtensionIdentity>,
    status: ExtensionActivationState["status"],
    error?: unknown,
  ): void {
    this.states.set(identity.id, {
      ...identity,
      status,
      ...(error === undefined ? {} : { error }),
    });
  }

  private createLogger(extensionId: string): ExtensionLogger {
    return Object.freeze({
      debug: (message: string, detail?: unknown) =>
        this.report(extensionId, "debug", "runtime", message, detail),
      info: (message: string, detail?: unknown) =>
        this.report(extensionId, "info", "runtime", message, detail),
      warn: (message: string, detail?: unknown) =>
        this.report(extensionId, "warning", "runtime", message, detail),
      error: (message: string, detail?: unknown) =>
        this.report(extensionId, "error", "runtime", message, detail),
    });
  }

  private report(
    extensionId: string,
    level: ExtensionDiagnosticLevel,
    phase: ExtensionDiagnosticPhase,
    message: string,
    detail?: unknown,
  ): void {
    const diagnostic: ExtensionDiagnostic = Object.freeze({
      extensionId,
      level,
      phase,
      message,
      timestamp: this.now(),
      ...(detail === undefined ? {} : { detail }),
    });

    if (this.maxDiagnostics > 0) {
      this.diagnostics.push(diagnostic);
      const overflow = this.diagnostics.length - this.maxDiagnostics;
      if (overflow > 0) {
        this.diagnostics.splice(0, overflow);
      }
    }

    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics sinks must not change extension lifecycle behaviour.
    }
  }

  private async disposeResources(
    extensionId: string,
    resources: readonly ExtensionResource[],
    phase: ExtensionDiagnosticPhase,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];

    for (const resource of [...resources].reverse()) {
      try {
        await disposeResource(resource);
      } catch (error) {
        errors.push(error);
        this.report(
          extensionId,
          "error",
          phase,
          "An extension resource failed to dispose.",
          error,
        );
      }
    }

    return errors;
  }
}
