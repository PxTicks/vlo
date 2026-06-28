"""Safe extension discovery and approval primitives."""

from services.extensions.approval_store import (
    ExtensionApproval,
    ExtensionApprovalStateError,
    ExtensionApprovalStore,
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
    "BackendExtensionEntry",
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
    "UnsafeExtensionPackageError",
    "compute_package_digest",
    "is_package_digest",
    "is_extension_sdk_compatible",
    "load_extension_manifest",
    "read_package_file_bytes",
    "read_package_files_bytes",
]
