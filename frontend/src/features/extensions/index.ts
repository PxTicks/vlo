export {
  DuplicateExtensionContributionError,
  ExtensionContributionRegistry,
  InvalidExtensionContributionIdError,
} from "./registry/ExtensionContributionRegistry";
export { ExtensionManagerDialog } from "./components/ExtensionManagerDialog";
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
  ExtensionResource,
} from "./types";
