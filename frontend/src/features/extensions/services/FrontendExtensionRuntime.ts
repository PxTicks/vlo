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
import { extensionTransformationRegistry } from "../../transformations/extensionApi";
import { extensionTransitionRegistry } from "../../transitions/extensions/ExtensionTransitionRegistry";
import { createExtensionAnimationApi } from "../../transformations/animation";
import { createExtensionBackendApi } from "../backend/createExtensionBackendApi";
import { createExtensionAssetApi } from "../assets/createExtensionAssetApi";
import { createExtensionGenerationApi } from "../generation/ExtensionGenerationBridge";
import { extensionUiSlotRegistry } from "../ui/ExtensionUiSlotRegistry";
import { extensionPanelControlRegistry } from "../ui/ExtensionPanelControlRegistry";
import { extensionHostRuntimeApi } from "./extensionHostRuntimeApi";
import { extensionColorApi } from "./extensionColorApi";
import {
  evaluateExtensionSdkCompatibility,
  evaluateExtensionVloCompatibility,
} from "../utils/sdkCompatibility";
import { VLO_APP_VERSION } from "../../project/constants";
import { trustedHostAccessDirectory } from "../runtime/TrustedHostAccessDirectory";
import { registerTrustedHostEntries } from "../runtime/registerTrustedHostEntries";
import {
  fetchExtensionInventory,
  type ExtensionInventoryItem,
} from "./extensionManagementApi";

const DEFAULT_INVENTORY_TIMEOUT_MS = 15_000;

export type FrontendExtensionStartStatus =
  | "active"
  | "failed"
  | "incompatible"
  | "waiting_backend";

export type FrontendExtensionStartStage =
  | "validation"
  | "compatibility"
  | "backend"
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

function approvedFrontendValidationError(
  item: ExtensionInventoryItem,
): string | null {
  if (item.manifest === null || item.manifest.frontend === undefined) {
    return "Approved frontend package has no frontend manifest entry.";
  }
  if (item.manifest.id !== item.id) {
    return "Frontend manifest identity does not match its inventory owner.";
  }
  if (item.digest === null || item.frontendEntryUrl === null) {
    return "Approved frontend package has no content-addressed entry URL.";
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
  private startPromise?: Promise<FrontendExtensionStartSummary>;

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
  }

  start(): Promise<FrontendExtensionStartSummary> {
    this.startPromise ??= this.runStartup();
    return this.startPromise;
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

    const results: FrontendExtensionStartResult[] = [];
    // Preserve deterministic activation/rollback order. Imports can be split
    // into a parallel preparation stage later once dependency ordering exists.
    for (const item of inventory) {
      if (
        item.status !== "approved" ||
        item.manifest?.frontend === undefined
      ) {
        continue;
      }

      const result = await this.activateInventoryItem(item);
      results.push(result);
      try {
        this.onResult?.(result);
      } catch {
        // Observers must not affect activation or failure isolation.
      }
    }

    return { inventoryLoaded: true, results };
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
    const validationError = approvedFrontendValidationError(item);
    if (
      validationError ||
      item.manifest === null ||
      item.digest === null ||
      item.frontendEntryUrl === null
    ) {
      return {
        extensionId: item.id,
        status: "failed",
        stage: "validation",
        message: validationError ?? "Approved frontend metadata is invalid.",
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
      assets: createExtensionAssetApi(scope),
      generation: createExtensionGenerationApi(scope),
      animation: createExtensionAnimationApi(scope),
      payloadProviders: extensionPayloadProviderRegistry.bind(scope),
      entityProviders: extensionEntityProviderRegistry.bind(scope),
      timeline: createExtensionTimelineApi(scope),
      transitions: extensionTransitionRegistry.bind(scope),
      // Presets live in their own generic registry but belong to the
      // transformation they patch, so authors register them next to it.
      transformations: Object.freeze({
        ...extensionTransformationRegistry.bind(scope),
        presets: extensionParameterPresetRegistry.bind(scope),
      }),
      // Panel controls live in their own registry but are exposed on the UI
      // domain, so an author sees one place to register UI.
      ui: Object.freeze({
        ...extensionUiSlotRegistry.bind(scope),
        ...extensionPanelControlRegistry.bind(scope),
      }),
    });

const frontendExtensionHost = new ExtensionHost<VloExtensionApi>({
  sdkVersion: VLO_EXTENSION_SDK_VERSION,
  hostVersion: VLO_APP_VERSION,
  createApi: createVloExtensionApi,
  onDiagnostic: reportHostDiagnostic,
});

export const frontendTrustedHostEntriesRegistration =
  registerTrustedHostEntries(frontendExtensionHost);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    frontendTrustedHostEntriesRegistration.dispose();
  });
}

export const frontendExtensionRuntime = new FrontendExtensionRuntime({
  host: frontendExtensionHost,
  loadInventory: (signal) => fetchExtensionInventory({ signal }),
  importModule: importApprovedFrontendModule,
  onCompatibilityWarning: (extensionId, message) => {
    console.warn(`[Extension ${extensionId}] ${message}`);
  },
  onResult: (result) => {
    if (result.status === "active") return;
    const output =
      result.status === "waiting_backend" ? console.warn : console.error;
    output(`[Extension ${result.extensionId}] ${result.message}`, result.error);
  },
});
