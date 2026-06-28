"""Safe extension discovery and approval primitives."""

from services.extensions.approval_store import (
    ExtensionApproval,
    ExtensionApprovalStateError,
    ExtensionApprovalStore,
)
from services.extensions.backend_artifacts import (
    BackendArtifactError,
    BackendArtifactStore,
    StagedBackendArtifacts,
)
from services.extensions.backend_runtime import (
    DEFAULT_BACKEND_EXTENSION_ACTIVATION_TIMEOUT_SECONDS,
    BackendExtensionActivationError,
    BackendExtensionActivationRecord,
    BackendExtensionActivationTimeoutError,
    BackendExtensionContext,
    BackendExtensionDefinition,
    BackendExtensionIdentity,
    BackendExtensionRuntime,
    BackendExtensionRuntimeView,
    BackendExtensionStartSummary,
)
from services.extensions.manager import (
    ExtensionInventoryError,
    ExtensionInventoryItem,
    ExtensionInventoryStatus,
    ExtensionManager,
)
from services.extensions.frontend_artifacts import (
    FrontendArtifactError,
    FrontendArtifactStore,
    StagedFrontendArtifacts,
)
from services.extensions.manifest import (
    BackendExtensionEntry,
    EXTENSION_SDK_VERSION,
    ExtensionManifest,
    ExtensionManifestError,
    FrontendExtensionEntry,
    is_extension_sdk_compatible,
    load_extension_manifest,
)
from services.extensions.package_digest import (
    ExtensionPackageChangedError,
    UnsafeExtensionPackageError,
    compute_package_digest,
    is_package_digest,
    read_package_file_bytes,
    read_package_files_bytes,
)

__all__ = [
    "BackendArtifactError",
    "BackendArtifactStore",
    "BackendExtensionEntry",
    "BackendExtensionActivationError",
    "BackendExtensionActivationRecord",
    "BackendExtensionActivationTimeoutError",
    "BackendExtensionContext",
    "BackendExtensionDefinition",
    "BackendExtensionIdentity",
    "BackendExtensionRuntime",
    "BackendExtensionRuntimeView",
    "BackendExtensionStartSummary",
    "DEFAULT_BACKEND_EXTENSION_ACTIVATION_TIMEOUT_SECONDS",
    "EXTENSION_SDK_VERSION",
    "ExtensionApproval",
    "ExtensionApprovalStateError",
    "ExtensionApprovalStore",
    "FrontendArtifactError",
    "FrontendArtifactStore",
    "ExtensionInventoryError",
    "ExtensionInventoryItem",
    "ExtensionInventoryStatus",
    "ExtensionManager",
    "ExtensionManifest",
    "ExtensionManifestError",
    "ExtensionPackageChangedError",
    "FrontendExtensionEntry",
    "StagedFrontendArtifacts",
    "StagedBackendArtifacts",
    "UnsafeExtensionPackageError",
    "compute_package_digest",
    "is_package_digest",
    "is_extension_sdk_compatible",
    "load_extension_manifest",
    "read_package_file_bytes",
    "read_package_files_bytes",
]
