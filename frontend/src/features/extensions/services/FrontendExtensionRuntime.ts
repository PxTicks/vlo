import { ExtensionHost } from "../ExtensionHost";
import { VLO_EXTENSION_SDK_VERSION } from "../constants";
import type {
  ExtensionApiFactory,
  ExtensionDiagnostic,
  ExtensionModule,
  VloExtensionApi,
} from "../types";
import { extensionPayloadProviderRegistry } from "../persistence/ExtensionPayloadProviderRegistry";
import { extensionParameterPresetRegistry } from "../registry/ExtensionParameterPresetRegistry";
import { extensionEntityProviderRegistry } from "../entities/ExtensionEntityProviderRegistry";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import { createExtensionPlaybackApi } from "../playback/createExtensionPlaybackApi";
import { createExtensionSelectionApi } from "../selection/createExtensionSelectionApi";
import { createExtensionProjectApi } from "../project/createExtensionProjectApi";
import { createExtensionExportApi } from "../export/createExtensionExportApi";
import { createExtensionAudioApi } from "../audio/createExtensionAudioApi";
import { createExtensionCapabilityApi } from "../capabilities/createExtensionCapabilityApi";
import { extensionTransformationRegistry } from "../../transformations/extensionApi";
import { extensionTransitionRegistry } from "../../transitions/extensions/ExtensionTransitionRegistry";
import { createExtensionAnimationApi } from "../../transformations/animation";
import { createExtensionBackendApi } from "../backend/createExtensionBackendApi";
import { createExtensionAssetApi } from "../assets/createExtensionAssetApi";
import { createExtensionGenerationApi } from "../generation/ExtensionGenerationBridge";
import { extensionUiSlotRegistry } from "../ui/ExtensionUiSlotRegistry";
import { extensionPanelControlRegistry } from "../ui/ExtensionPanelControlRegistry";
import { createExtensionCommandApi } from "../commands/CommandRegistry";
import { extensionMenuPlacementRegistry } from "../menus/ExtensionMenuPlacementRegistry";
import { createExtensionCatalogueApi } from "../catalogues/createExtensionCatalogueApi";
import { installHostContextKeyBindings } from "../commands/installHostContextKeys";
import { installHostKeybindingReservations } from "../commands/installHostKeybindingReservations";
import { createExtensionStorageApi } from "../storage/createExtensionStorageApi";
import { installExtensionProjectStorage } from "../storage/installExtensionProjectStorage";
import { installTimelineHostCommands } from "../../timeline/api";
import { installProjectHostCommands } from "../../project/hostCommands";
import { createExtensionViewApi } from "../views/createExtensionViewApi";
import { createExtensionCanvasToolApi } from "../canvas/ExtensionCanvasToolRegistry";
import { extensionHostRuntimeApi } from "./extensionHostRuntimeApi";
import { extensionColorApi } from "./extensionColorApi";
import {
  evaluateExtensionSdkCompatibility,
  evaluateExtensionVersionCompatibility,
  evaluateExtensionVloCompatibility,
} from "../utils/sdkCompatibility";
import {
  extensionPeerRegistry,
  type ExtensionPeerRegistry,
} from "../peers/ExtensionPeerRegistry";
import {
  isProjectOpen,
  parseActivationEvent,
  subscribeProjectOpen,
  type ParsedActivationEvent,
} from "./activationEvents";
import { createExtensionNotificationApi } from "../ui/createExtensionNotificationApi";
import { createExtensionScopeApi } from "../scopes/createExtensionScopeApi";
import { postHostToast } from "../../../core/shell/notificationCenter";
import { VLO_APP_VERSION } from "../../project/constants";
import { trustedHostAccessDirectory } from "../runtime/TrustedHostAccessDirectory";
import { registerTrustedHostEntries } from "../runtime/registerTrustedHostEntries";
import {
  fetchExtensionInventory,
  type ExtensionInventoryItem,
} from "./extensionManagementApi";
import { projectManifestContributions } from "./manifestContributions";

const DEFAULT_INVENTORY_TIMEOUT_MS = 15_000;

export type FrontendExtensionStartStatus =
  | "active"
  | "failed"
  | "incompatible"
  | "waiting_backend"
  /** Approved and valid, but its activation events have not fired yet. */
  | "deferred";

export type FrontendExtensionStartStage =
  | "validation"
  | "compatibility"
  | "backend"
  | "dependencies"
  | "import"
  | "activation";

export interface FrontendExtensionStartResult {
  extensionId: string;
  status: FrontendExtensionStartStatus;
  stage: FrontendExtensionStartStage;
  message: string;
  digest?: string;
  error?: unknown;
}

export interface FrontendExtensionStartSummary {
  inventoryLoaded: boolean;
  results: readonly FrontendExtensionStartResult[];
  inventoryError?: unknown;
}

export type FrontendExtensionModuleImporter = (
  url: string,
) => Promise<unknown>;

export interface FrontendExtensionRuntimeOptions<TApi extends object> {
  host: ExtensionHost<TApi>;
  loadInventory(signal: AbortSignal): Promise<ExtensionInventoryItem[]>;
  importModule: FrontendExtensionModuleImporter;
  inventoryTimeoutMs?: number | null;
  evaluateCompatibility?: typeof evaluateExtensionSdkCompatibility;
  evaluateVloCompatibility?: typeof evaluateExtensionVloCompatibility;
  onCompatibilityWarning?: (extensionId: string, message: string) => void;
  onResult?: (result: FrontendExtensionStartResult) => void;
  peers?: ExtensionPeerRegistry;
  /** Seam for the `onProjectOpen` activation event; see `activationEvents.ts`. */
  isProjectOpen?: () => boolean;
  subscribeProjectOpen?: (listener: () => void) => () => void;
}

interface PendingPackage {
  readonly item: ExtensionInventoryItem;
  readonly events: readonly ParsedActivationEvent[];
  readonly dependencies: Readonly<Record<string, string>>;
  state: "pending" | "activating" | "settled";
  result?: FrontendExtensionStartResult;
}

export class FrontendExtensionInventoryTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Frontend extension inventory timed out after ${timeoutMs}ms.`);
    this.name = "FrontendExtensionInventoryTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function isExtensionModule<TApi extends object>(
  value: unknown,
): value is ExtensionModule<TApi> {
  return (
    typeof value === "object" &&
    value !== null &&
    "activate" in value &&
    typeof value.activate === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A package that declares no activation events activates at startup, which is
 * what every package did before events existed. Unrecognised entries are
 * dropped rather than failing the package: the backend validator already
 * rejects them, so reaching here means a host that no longer publishes an event
 * an older package declared.
 */
function readActivationEvents(
  declared: readonly string[] | undefined,
): readonly ParsedActivationEvent[] {
  if (declared === undefined || declared.length === 0) {
    return [{ kind: "startup" }];
  }
  const events = declared
    .map(parseActivationEvent)
    .filter((event): event is ParsedActivationEvent => event !== null);
  return events.length === 0 ? [{ kind: "startup" }] : events;
}

function deferredResult(entry: PendingPackage): FrontendExtensionStartResult {
  const events = entry.item.manifest?.activationEvents ?? [];
  return {
    extensionId: entry.item.id,
    status: "deferred",
    stage: "activation",
    message: `Waiting for activation events: ${events.join(", ")}.`,
    ...(entry.item.digest === null ? {} : { digest: entry.item.digest }),
  };
}

function approvedPackageValidationError(
  item: ExtensionInventoryItem,
): string | null {
  if (item.manifest === null) return "Approved package has no valid manifest.";
  if (item.manifest.id !== item.id) {
    return "Package manifest identity does not match its inventory owner.";
  }
  if (item.digest === null) {
    return "Approved package has no content-addressed digest.";
  }
  if (
    item.approval === null ||
    !item.approval.enabled ||
    item.approval.digest !== item.digest
  ) {
    return "Frontend package approval does not match its current digest.";
  }
  return null;
}

export async function importApprovedFrontendModule(
  url: string,
): Promise<unknown> {
  return import(/* @vite-ignore */ url) as Promise<unknown>;
}

export class FrontendExtensionRuntime<TApi extends object> {
  private readonly host: ExtensionHost<TApi>;
  private readonly loadInventory: (
    signal: AbortSignal,
  ) => Promise<ExtensionInventoryItem[]>;
  private readonly importModule: FrontendExtensionModuleImporter;
  private readonly inventoryTimeoutMs: number | null;
  private readonly evaluateCompatibility: typeof evaluateExtensionSdkCompatibility;
  private readonly evaluateVloCompatibility: typeof evaluateExtensionVloCompatibility;
  private readonly hostVersion: string | null;
  private readonly onCompatibilityWarning?: (
    extensionId: string,
    message: string,
  ) => void;
  private readonly onResult?: (result: FrontendExtensionStartResult) => void;
  private readonly peers: ExtensionPeerRegistry;
  private readonly isProjectOpen: () => boolean;
  private readonly subscribeProjectOpen: (listener: () => void) => () => void;
  private readonly pending = new Map<string, PendingPackage>();
  private startPromise?: Promise<FrontendExtensionStartSummary>;
  private unsubscribeProjectOpen?: () => void;

  constructor(options: FrontendExtensionRuntimeOptions<TApi>) {
    this.host = options.host;
    this.loadInventory = options.loadInventory;
    this.importModule = options.importModule;
    this.inventoryTimeoutMs =
      options.inventoryTimeoutMs === undefined
        ? DEFAULT_INVENTORY_TIMEOUT_MS
        : options.inventoryTimeoutMs;
    if (
      this.inventoryTimeoutMs !== null &&
      (!Number.isFinite(this.inventoryTimeoutMs) || this.inventoryTimeoutMs <= 0)
    ) {
      throw new RangeError("inventoryTimeoutMs must be positive or null.");
    }
    this.evaluateCompatibility =
      options.evaluateCompatibility ?? evaluateExtensionSdkCompatibility;
    this.evaluateVloCompatibility =
      options.evaluateVloCompatibility ?? evaluateExtensionVloCompatibility;
    const hostVersion = options.host.getHostVersion();
    this.hostVersion =
      hostVersion === undefined ? VLO_APP_VERSION : hostVersion;
    this.onCompatibilityWarning = options.onCompatibilityWarning;
    this.onResult = options.onResult;
    this.peers = options.peers ?? extensionPeerRegistry;
    this.isProjectOpen = options.isProjectOpen ?? isProjectOpen;
    this.subscribeProjectOpen = options.subscribeProjectOpen ?? subscribeProjectOpen;
  }

  start(): Promise<FrontendExtensionStartSummary> {
    this.startPromise ??= this.runStartup();
    return this.startPromise;
  }

  /** Stops watching for deferred activation events. */
  dispose(): void {
    this.unsubscribeProjectOpen?.();
    this.unsubscribeProjectOpen = undefined;
  }

  private async runStartup(): Promise<FrontendExtensionStartSummary> {
    let inventory: ExtensionInventoryItem[];
    try {
      inventory = await this.loadInventoryWithTimeout();
    } catch (error) {
      return {
        inventoryLoaded: false,
        results: [],
        inventoryError: error,
      };
    }

    // Declarations first, for every approved package: a dependent may activate
    // before its dependency's own event fires, and `api.extensions` has to be
    // able to answer for a peer the host has not reached yet.
    for (const item of inventory) {
      if (item.status !== "approved" || item.manifest?.frontend === undefined) {
        continue;
      }
      const manifest = item.manifest;
      const dependencies = manifest.dependencies ?? {};
      this.peers.declarePackage({
        id: item.id,
        version: manifest.version,
        dependencies,
      });
      this.pending.set(item.id, {
        item,
        events: readActivationEvents(manifest.activationEvents),
        dependencies,
        state: "pending",
      });
    }

    // Inventory order is the activation order within one event, so rollback and
    // diagnostics stay deterministic; dependencies pull their providers forward.
    for (const id of [...this.pending.keys()]) {
      const entry = this.pending.get(id);
      if (!entry || !entry.events.some((event) => event.kind === "startup")) {
        continue;
      }
      await this.activatePackage(id, []);
    }

    await this.runProjectOpenEvent();

    const results = [...this.pending.values()].map(
      (entry) => entry.result ?? deferredResult(entry),
    );
    return { inventoryLoaded: true, results };
  }

  /**
   * Runs the `onProjectOpen` wave, or arms it for the first project to open.
   * Only the leading edge matters: a package activated for one project stays
   * active across later switches, exactly as a startup package does.
   */
  private async runProjectOpenEvent(): Promise<void> {
    const waiting = [...this.pending.values()].some(
      (entry) =>
        entry.state === "pending" &&
        entry.events.some((event) => event.kind === "project-open"),
    );
    if (!waiting) return;
    if (!this.isProjectOpen()) {
      this.unsubscribeProjectOpen ??= this.subscribeProjectOpen(() => {
        void this.activateForEvent((event) => event.kind === "project-open");
      });
      return;
    }
    await this.activateForEvent((event) => event.kind === "project-open");
  }

  private async activateForEvent(
    matches: (event: ParsedActivationEvent) => boolean,
  ): Promise<void> {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.state !== "pending" || !entry.events.some(matches)) continue;
      await this.activatePackage(id, []);
    }
  }

  /**
   * Activates one package and everything it declares a dependency on, in
   * provider-before-dependent order. `chain` carries the in-flight dependents so
   * a cycle is refused rather than recursing forever.
   */
  private async activatePackage(
    extensionId: string,
    chain: readonly string[],
  ): Promise<FrontendExtensionStartResult> {
    const entry = this.pending.get(extensionId);
    if (!entry) {
      return {
        extensionId,
        status: "failed",
        stage: "dependencies",
        message: `No approved frontend package '${extensionId}' is installed.`,
      };
    }
    if (entry.state === "settled" && entry.result) return entry.result;
    if (entry.state === "activating" || chain.includes(extensionId)) {
      return this.settle(entry, {
        extensionId,
        status: "failed",
        stage: "dependencies",
        message:
          `Dependency cycle: ${[...chain, extensionId].join(" -> ")}. ` +
          "Extensions cannot depend on each other in a loop.",
        ...(entry.item.digest === null ? {} : { digest: entry.item.digest }),
      });
    }

    entry.state = "activating";
    const dependencyFailure = await this.activateDependencies(entry, [
      ...chain,
      extensionId,
    ]);
    if (dependencyFailure) return this.settle(entry, dependencyFailure);

    const result = this.settle(
      entry,
      await this.activateInventoryItem(entry.item),
    );
    if (result.status === "active") {
      this.peers.markActive(extensionId);
      await this.activateForEvent(
        (event) => event.kind === "extension" && event.extensionId === extensionId,
      );
    } else {
      this.peers.retract(extensionId);
    }
    return result;
  }

  /** Returns a failure result when a declared dependency cannot be satisfied. */
  private async activateDependencies(
    entry: PendingPackage,
    chain: readonly string[],
  ): Promise<FrontendExtensionStartResult | null> {
    const extensionId = entry.item.id;
    const digest = entry.item.digest;
    const fail = (message: string): FrontendExtensionStartResult => ({
      extensionId,
      status: "failed",
      stage: "dependencies",
      message,
      ...(digest === null ? {} : { digest }),
    });

    for (const [dependencyId, range] of Object.entries(entry.dependencies)) {
      if (dependencyId === extensionId) {
        return fail("An extension cannot declare itself as a dependency.");
      }
      const dependency = this.pending.get(dependencyId);
      if (!dependency) {
        return fail(
          `Required extension '${dependencyId}' is not installed, approved, or ` +
            "does not provide a frontend module.",
        );
      }
      const version = dependency.item.manifest?.version ?? null;
      const compatibility = evaluateExtensionVersionCompatibility(
        range,
        version,
        `extension '${dependencyId}'`,
      );
      if (!compatibility.compatible) {
        return fail(
          compatibility.reason ??
            `Required extension '${dependencyId}' does not satisfy '${range}'.`,
        );
      }
      if (compatibility.warning) {
        this.onCompatibilityWarning?.(extensionId, compatibility.warning);
      }
      const dependencyResult = await this.activatePackage(dependencyId, chain);
      // A cycle settles *this* package from inside that recursion, with the
      // diagnostic that names the whole loop. Stop here rather than pulling in
      // the remaining dependencies of a package that can no longer activate.
      if (entry.state === "settled" && entry.result) return entry.result;
      if (dependencyResult.status !== "active") {
        return fail(
          `Required extension '${dependencyId}' did not activate: ` +
            dependencyResult.message,
        );
      }
    }
    return null;
  }

  /**
   * Records one package's outcome exactly once.
   *
   * Idempotent on purpose: a package caught in a cycle is settled by the frame
   * that *detected* the cycle, and its own outer frame then arrives with the
   * derived "required extension did not activate" message. The first result is
   * the specific one, so it wins — and an observer sees one notification per
   * package rather than one per frame that noticed.
   */
  private settle(
    entry: PendingPackage,
    result: FrontendExtensionStartResult,
  ): FrontendExtensionStartResult {
    if (entry.state === "settled" && entry.result) return entry.result;
    entry.state = "settled";
    entry.result = result;
    try {
      this.onResult?.(result);
    } catch {
      // Observers must not affect activation or failure isolation.
    }
    return result;
  }

  private loadInventoryWithTimeout(): Promise<ExtensionInventoryItem[]> {
    const controller = new AbortController();
    const inventory = this.loadInventory(controller.signal);
    if (this.inventoryTimeoutMs === null) return inventory;

    const timeoutMs = this.inventoryTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        controller.abort();
        reject(new FrontendExtensionInventoryTimeoutError(timeoutMs));
      }, timeoutMs);
      inventory.then(
        (items) => {
          clearTimeout(timeoutId);
          resolve(items);
        },
        (error: unknown) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private async activateInventoryItem(
    item: ExtensionInventoryItem,
  ): Promise<FrontendExtensionStartResult> {
    const validationError = approvedPackageValidationError(item);
    if (
      validationError ||
      item.manifest === null ||
      item.digest === null
    ) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "validation",
        message: validationError ?? "Approved frontend metadata is invalid.",
      };
    }

    if (item.frontendEntryUrl === null) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "validation",
        message: "Approved frontend package has no content-addressed entry URL.",
        digest: item.digest,
      };
    }

    const compatibility = this.evaluateCompatibility(item.manifest.sdk);
    if (!compatibility.compatible) {
      return {
        extensionId: item.id,
        status: "incompatible",
        stage: "compatibility",
        message:
          compatibility.reason ?? "The extension SDK range is incompatible.",
        digest: item.digest,
      };
    }

    if (item.manifest.vlo !== undefined) {
      const vloCompatibility = this.evaluateVloCompatibility(
        item.manifest.vlo,
        this.hostVersion,
      );
      if (!vloCompatibility.compatible) {
        return {
          extensionId: item.id,
          status: "incompatible",
          stage: "compatibility",
          message:
            vloCompatibility.reason ??
            "The extension VLO application range is incompatible.",
          digest: item.digest,
        };
      }
      if (vloCompatibility.warning) {
        this.onCompatibilityWarning?.(
          item.id,
          vloCompatibility.warning,
        );
      }
    }

    if (
      item.manifest.backend !== undefined &&
      (item.backendRuntime.status !== "active" ||
        item.backendRuntime.digest !== item.digest)
    ) {
      const readinessMessage =
        item.backendRuntime.status === "active"
          ? "The active backend digest does not match the approved frontend digest."
          : item.backendRuntime.message;
      return {
        extensionId: item.id,
        status: "waiting_backend",
        stage: "backend",
        message: `Frontend activation is waiting for backend readiness: ${readinessMessage}`,
        digest: item.digest,
      };
    }

    let importedModule: unknown;
    try {
      importedModule = await this.importModule(item.frontendEntryUrl);
    } catch (error) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "import",
        message: `Frontend module import failed: ${errorMessage(error)}`,
        digest: item.digest,
        error,
      };
    }

    if (!isExtensionModule<TApi>(importedModule)) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "validation",
        message: "Frontend module must export an activate(context) function.",
        digest: item.digest,
      };
    }

    try {
      await this.host.activate(
        { id: item.id, version: item.manifest.version },
        importedModule,
      );
      return {
        extensionId: item.id,
        status: "active",
        stage: "activation",
        message: "Frontend extension activated.",
        digest: item.digest,
      };
    } catch (error) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "activation",
        message: `Frontend activation failed: ${errorMessage(error)}`,
        digest: item.digest,
        error,
      };
    }
  }
}

function reportHostDiagnostic(diagnostic: ExtensionDiagnostic): void {
  if (diagnostic.level !== "warning" && diagnostic.level !== "error") return;
  const output = diagnostic.level === "error" ? console.error : console.warn;
  output(
    `[Extension ${diagnostic.extensionId}] ${diagnostic.message}`,
    diagnostic.detail,
  );
}

export const createVloExtensionApi: ExtensionApiFactory<VloExtensionApi> =
  (scope) =>
    Object.freeze({
      trusted: Object.freeze({
        host: trustedHostAccessDirectory.bind(
          scope,
          scope.hostVersion === undefined ? VLO_APP_VERSION : scope.hostVersion,
        ),
      }),
      runtime: extensionHostRuntimeApi,
      color: extensionColorApi,
      backend: createExtensionBackendApi(scope),
      capabilities: createExtensionCapabilityApi(scope),
      assets: createExtensionAssetApi(scope),
      storage: createExtensionStorageApi(scope),
      generation: createExtensionGenerationApi(scope),
      animation: createExtensionAnimationApi(scope),
      payloadProviders: extensionPayloadProviderRegistry.bind(scope),
      entityProviders: extensionEntityProviderRegistry.bind(scope),
      timeline: createExtensionTimelineApi(scope),
      playback: createExtensionPlaybackApi(scope),
      selection: createExtensionSelectionApi(scope),
      project: createExtensionProjectApi(scope),
      audio: createExtensionAudioApi(scope),
      export: createExtensionExportApi(scope),
      transitions: extensionTransitionRegistry.bind(scope),
      // Presets live in their own generic registry but belong to the
      // transformation they patch, so authors register them next to it.
      transformations: Object.freeze({
        ...extensionTransformationRegistry.bind(scope),
        presets: extensionParameterPresetRegistry.bind(scope),
      }),
      // Panel controls, commands, and menu placements live in their own
      // registries but are exposed on the UI domain, so an author sees one
      // place to register UI.
      ui: Object.freeze({
        ...extensionUiSlotRegistry.bind(scope),
        ...extensionPanelControlRegistry.bind(scope),
        ...createExtensionViewApi(scope),
        commands: createExtensionCommandApi(scope),
        menus: extensionMenuPlacementRegistry.bind(scope),
        catalogues: createExtensionCatalogueApi(scope),
        canvasTools: createExtensionCanvasToolApi(scope),
        notifications: createExtensionNotificationApi(scope),
        scopes: createExtensionScopeApi(scope),
      }),
      extensions: extensionPeerRegistry.bind(scope),
    });

const frontendExtensionHost = new ExtensionHost<VloExtensionApi>({
  sdkVersion: VLO_EXTENSION_SDK_VERSION,
  hostVersion: VLO_APP_VERSION,
  createApi: createVloExtensionApi,
  // The host owns *when* an export becomes visible — only after activation
  // succeeds, and never after deactivation starts. The registry owns who may
  // read it.
  onExport: (identity, api) => {
    if (api === undefined) extensionPeerRegistry.retract(identity.id);
    else extensionPeerRegistry.publishApi(identity.id, api);
  },
  onDiagnostic: reportHostDiagnostic,
});

export const frontendTrustedHostEntriesRegistration =
  registerTrustedHostEntries(frontendExtensionHost);
export const frontendHostContextKeyRegistration =
  installHostContextKeyBindings();
export const frontendTimelineHostCommandRegistration =
  installTimelineHostCommands();
export const frontendProjectHostCommandRegistration =
  installProjectHostCommands();
// Reservations must exist before any extension activates so colliding
// extension bindings are shadowed at registration, never dispatched.
export const frontendHostKeybindingReservationRegistration =
  installHostKeybindingReservations();
export const frontendExtensionProjectStorageRegistration =
  installExtensionProjectStorage();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    frontendTrustedHostEntriesRegistration.dispose();
    void frontendHostContextKeyRegistration.dispose();
    void frontendTimelineHostCommandRegistration.dispose();
    void frontendProjectHostCommandRegistration.dispose();
    void frontendHostKeybindingReservationRegistration.dispose();
    void frontendExtensionProjectStorageRegistration.dispose();
  });
}

export const frontendExtensionRuntime = new FrontendExtensionRuntime({
  host: frontendExtensionHost,
  loadInventory: async (signal) => {
    const inventory = await fetchExtensionInventory({ signal });
    const diagnostics = projectManifestContributions(inventory);
    for (const diagnostic of diagnostics) {
      const output = diagnostic.level === "warning" ? console.warn : console.error;
      output(
        `[Extension ${diagnostic.extensionId}] ${diagnostic.message}`,
        diagnostic.error,
      );
    }
    return inventory;
  },
  importModule: importApprovedFrontendModule,
  onCompatibilityWarning: (extensionId, message) => {
    console.warn(`[Extension ${extensionId}] ${message}`);
  },
  onResult: (result) => {
    if (result.status === "active" || result.status === "deferred") return;
    const output =
      result.status === "waiting_backend" ? console.warn : console.error;
    output(`[Extension ${result.extensionId}] ${result.message}`, result.error);
    // An extension that silently fails to start looks to the user like one that
    // was never installed. The console is not where they will look.
    postHostToast(
      `Extension '${result.extensionId}' did not start: ${result.message}`,
      result.status === "waiting_backend" ? "warning" : "error",
      0,
    );
  },
});
