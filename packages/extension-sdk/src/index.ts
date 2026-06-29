/**
 * Contribution metadata reserved for the trusted/restricted dispatch split.
 * SDK 1 records this value but does not enforce isolation.
 */
export type ExtensionExecutionMode = "trusted" | "restricted";

export type ExtensionLifecycleResult = void | ExtensionResource;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Opaque, versioned data owned by one extension contribution. */
export interface ExtensionPayload {
  extensionId: string;
  typeId: string;
  schemaVersion: number;
  data: JsonValue;
  /** Host-readable dependencies retained even when the provider is missing. */
  assetReferences?: readonly string[];
}

export interface ExtensionPayloadMigration {
  schemaVersion: number;
  data: JsonValue;
}

/**
 * Persistence-only contract for one extension-owned payload type. Rendering
 * and editor UI are separate contribution contracts.
 */
export interface ExtensionPayloadProviderDefinition {
  id: string;
  apiVersion: 1;
  schemaVersion: number;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionPayloadMigration;
  getAssetReferences?(
    data: JsonValue,
    schemaVersion: number,
  ): readonly string[];
}

export interface ExtensionPayloadProviderRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionPayloadProviderApi {
  register(
    definition: ExtensionPayloadProviderDefinition,
  ): ExtensionPayloadProviderRegistration;
}

export interface ExtensionTimelineEntitySnapshot {
  readonly id: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineEntityCreateInput {
  readonly name: string;
  readonly trackId?: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineTransaction {
  /** Returns the host-generated entity ID used by later commands in this transaction. */
  createEntity(input: ExtensionTimelineEntityCreateInput): string;
  updatePayload(entityId: string, payload: ExtensionPayload): void;
  moveEntity(
    entityId: string,
    placement: { readonly startTicks?: number; readonly trackId?: string },
  ): void;
  removeEntity(entityId: string): void;
}

export type ExtensionTimelineTransactionFailureCode =
  | "invalid_label"
  | "invalid_command"
  | "entity_not_found"
  | "wrong_owner"
  | "incompatible_payload"
  | "callback_failed";

export type ExtensionTimelineTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code: ExtensionTimelineTransactionFailureCode;
      readonly message: string;
      readonly label: string;
    };

export interface ExtensionTimelineApi {
  /**
   * Returns a detached snapshot for commands and UI events. This clones every
   * payload and is not intended as a render-loop or polling accessor.
   */
  listEntities(): readonly ExtensionTimelineEntitySnapshot[];
  transaction(
    label: string,
    callback: (transaction: ExtensionTimelineTransaction) => void,
  ): ExtensionTimelineTransactionResult;
}

/**
 * Host-owned filters an SDK 1 transformation may parameterize. Each is a
 * built-in vlo filter executed by the host; extensions supply only declarative
 * numeric controls, never filter code. New entries widen this allow-list and
 * never expose arbitrary shaders.
 */
export type ExtensionHostFilter =
  | "color-adjustment"
  | "hsl-adjustment"
  | "bloom"
  | "glow"
  | "crt"
  | "old-film"
  | "dot"
  | "ascii"
  | "bulge-pinch";

export interface ExtensionTransformationNumberControl {
  readonly type: "slider" | "number";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly supportsSpline?: boolean;
}

export interface ExtensionTransformationControlGroup {
  readonly id: string;
  readonly title: string;
  readonly columns?: number;
  readonly controls: readonly ExtensionTransformationNumberControl[];
}

/** Declarative SDK 1 transformation backed by a host-owned filter runtime. */
export interface ExtensionTransformationDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "host-filter";
  readonly hostFilter: ExtensionHostFilter;
  readonly label: string;
  readonly adjustmentCompatible?: boolean;
  readonly groups: readonly ExtensionTransformationControlGroup[];
}

export interface ExtensionTransformationRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTransformationApi {
  register(
    definition: ExtensionTransformationDefinition,
  ): ExtensionTransformationRegistration;
}

export type ExtensionUiSlotId = "transformation-panel.before";
export type ExtensionUiNoticeTone = "info" | "success" | "warning";

/** Declarative native UI contribution; arbitrary React slots are not portable SDK 1. */
export interface ExtensionUiNoticeDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiSlotId;
  readonly kind: "notice";
  readonly title: string;
  readonly message: string;
  readonly tone?: ExtensionUiNoticeTone;
}

export interface ExtensionUiRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionUiApi {
  registerNotice(
    definition: ExtensionUiNoticeDefinition,
  ): ExtensionUiRegistration;
}

export interface VloExtensionApi {
  readonly payloadProviders: ExtensionPayloadProviderApi;
  readonly timeline: ExtensionTimelineApi;
  readonly transformations: ExtensionTransformationApi;
  readonly ui: ExtensionUiApi;
}

export interface ExtensionIdentity {
  id: string;
  version: string;
}

export interface ExtensionDisposable {
  dispose(): void | Promise<void>;
}

export type ExtensionCleanup = () => void | Promise<void>;
export type ExtensionResource = ExtensionDisposable | ExtensionCleanup;

export type ExtensionDiagnosticLevel = "debug" | "info" | "warning" | "error";
export type ExtensionDiagnosticPhase =
  | "activation"
  | "runtime"
  | "deactivation";

export interface ExtensionDiagnostic {
  extensionId: string;
  level: ExtensionDiagnosticLevel;
  phase: ExtensionDiagnosticPhase;
  message: string;
  timestamp: number;
  detail?: unknown;
}

export interface ExtensionLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ExtensionContext<TApi extends object = VloExtensionApi> {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly sdkVersion: string;
  readonly signal: AbortSignal;
  readonly api: TApi;
  readonly logger: ExtensionLogger;
  onDispose(resource: ExtensionResource): void;
}

export interface ExtensionModule<TApi extends object = VloExtensionApi> {
  activate(
    context: ExtensionContext<TApi>,
  ): ExtensionLifecycleResult | Promise<ExtensionLifecycleResult>;
}

export type ExtensionActivationStatus =
  | "inactive"
  | "activating"
  | "active"
  | "deactivating"
  | "failed";

export interface ExtensionActivationState extends ExtensionIdentity {
  status: ExtensionActivationStatus;
  error?: unknown;
}

export interface ExtensionApiScope {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly signal: AbortSignal;
  own<TResource extends ExtensionResource>(resource: TResource): TResource;
  report(
    level: ExtensionDiagnosticLevel,
    message: string,
    detail?: unknown,
  ): void;
}

export type ExtensionApiFactory<TApi extends object> = (
  scope: ExtensionApiScope,
) => TApi;
