export {
  DuplicateExtensionContributionError,
  ExtensionContributionRegistry,
  InvalidExtensionContributionIdError,
} from "./registry/ExtensionContributionRegistry";
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
