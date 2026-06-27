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
from services.extensions.manifest import (
    BackendExtensionEntry,
    ExtensionManifest,
    ExtensionManifestError,
    FrontendExtensionEntry,
    load_extension_manifest,
)
from services.extensions.package_digest import (
    ExtensionPackageChangedError,
    UnsafeExtensionPackageError,
    compute_package_digest,
    is_package_digest,
)

__all__ = [
    "BackendExtensionEntry",
    "ExtensionApproval",
    "ExtensionApprovalStateError",
    "ExtensionApprovalStore",
    "ExtensionInventoryError",
    "ExtensionInventoryItem",
    "ExtensionInventoryStatus",
    "ExtensionManager",
    "ExtensionManifest",
    "ExtensionManifestError",
    "ExtensionPackageChangedError",
    "FrontendExtensionEntry",
    "UnsafeExtensionPackageError",
    "compute_package_digest",
    "is_package_digest",
    "load_extension_manifest",
]
