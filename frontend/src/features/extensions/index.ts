export {
  DuplicateExtensionContributionError,
  ExtensionContributionRegistry,
  InvalidExtensionContributionIdError,
} from "./registry/ExtensionContributionRegistry";
export { ExtensionManagerDialog } from "./components/ExtensionManagerDialog";
export { FrontendExtensionBootstrap } from "./components/FrontendExtensionBootstrap";
export { VLO_EXTENSION_SDK_VERSION } from "./constants";
export {
  extensionPayloadSchema,
  jsonValueSchema,
} from "./persistence/extensionPayload";
export {
  collectProjectExtensionRequirements,
  getExtensionPayloadProviderId,
} from "./persistence/extensionRequirements";
export {
  ExtensionPayloadProviderRegistry,
  extensionPayloadProviderRegistry,
} from "./persistence/ExtensionPayloadProviderRegistry";
export type {
  ExtensionPayloadAssetReferenceResolution,
  ExtensionPayloadResolution,
} from "./persistence/ExtensionPayloadProviderRegistry";
export type {
  ExtensionProviderAvailability,
  ExtensionProviderAvailabilityResolver,
  ExtensionRequirementSource,
  ProjectExtensionRequirement,
} from "./persistence/extensionRequirements";
export type {
  BoundExtensionContributionRegistry,
  ExtensionContributionDefinition,
  ExtensionContributionRegistration,
  RegisteredExtensionContribution,
} from "./registry/ExtensionContributionRegistry";
export {
  ExtensionActivationError,
  ExtensionActivationCancelledError,
  ExtensionActivationTimeoutError,
  ExtensionDeactivationError,
  ExtensionHost,
  ExtensionLifecycleStateError,
  ExtensionRegistrationClosedError,
  InvalidExtensionIdentityError,
  InvalidExtensionResourceError,
} from "./ExtensionHost";
export type { ExtensionHostOptions } from "./ExtensionHost";
export type {
  ExtensionInventoryItem,
  ExtensionInventoryStatus,
} from "./services/extensionManagementApi";
export type {
  ExtensionActivationState,
  ExtensionActivationStatus,
  ExtensionApiFactory,
  ExtensionApiScope,
  ExtensionCleanup,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionDiagnosticLevel,
  ExtensionDiagnosticPhase,
  ExtensionDisposable,
  ExtensionExecutionMode,
  ExtensionIdentity,
  ExtensionLifecycleResult,
  ExtensionLogger,
  ExtensionModule,
  ExtensionPayload,
  ExtensionPayloadMigration,
  ExtensionPayloadProviderApi,
  ExtensionPayloadProviderDefinition,
  ExtensionPayloadProviderRegistration,
  ExtensionResource,
  ExtensionTimelineApi,
  ExtensionTimelineEntityCreateInput,
  ExtensionTimelineEntitySnapshot,
  ExtensionTimelineTransaction,
  ExtensionTimelineTransactionFailureCode,
  ExtensionTimelineTransactionResult,
  JsonValue,
  VloExtensionApi,
} from "./types";
