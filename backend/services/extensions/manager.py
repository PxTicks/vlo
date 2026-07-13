"""Inert extension inventory and exact-digest approval management."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from services.extensions.approval_store import ExtensionApproval, ExtensionApprovalStore
from services.extensions.manifest import (
    ExtensionManifest,
    ExtensionManifestError,
    backend_entry_candidates,
    load_extension_manifest,
    is_stable_semver_range_compatible,
)
from services.extensions.host_version import VLO_APPLICATION_VERSION
from services.extensions.package_digest import (
    PackageSnapshot,
    UnsafeExtensionPackageError,
    compute_package_digest,
    inspect_package_snapshot,
)

ExtensionInventoryStatus = Literal[
    "invalid",
    "pending_approval",
    "approved",
    "changed",
    "disabled",
]

_EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")


class ExtensionInventoryError(ValueError):
    """Raised when an inventory mutation does not match current package state."""


@dataclass(frozen=True)
class ExtensionInventoryItem:
    extension_id: str
    package_dir: Path
    manifest: ExtensionManifest | None
    digest: str | None
    status: ExtensionInventoryStatus
    errors: tuple[str, ...] = ()
    approval: ExtensionApproval | None = None

    @property
    def is_approved_for_activation(self) -> bool:
        return self.status == "approved"


@dataclass(frozen=True)
class _CachedPackageDigest:
    snapshot: PackageSnapshot
    digest: str


class ExtensionManager:
    def __init__(
        self,
        extensions_root: Path,
        approval_store: ExtensionApprovalStore,
    ) -> None:
        resolved_root = extensions_root.resolve()
        resolved_state = approval_store.state_path.resolve()
        if resolved_state == resolved_root or resolved_root in resolved_state.parents:
            raise ExtensionInventoryError(
                "approval state must be stored outside the extensions root"
            )
        self._extensions_root = extensions_root
        self._approval_store = approval_store
        self._digest_cache: dict[Path, _CachedPackageDigest] = {}

    @property
    def extensions_root(self) -> Path:
        return self._extensions_root

    def scan(self, *, force_digest: bool = False) -> list[ExtensionInventoryItem]:
        """Return inert inventory, reusing byte hashes for unchanged snapshots.

        Metadata caching keeps polling cheap. Approval and future activation use
        ``force_digest=True`` so trust decisions always hash current file bytes.
        """

        approvals = self._approval_store.list()
        if not self._extensions_root.exists():
            return []
        if self._extensions_root.is_symlink() or not self._extensions_root.is_dir():
            raise ExtensionInventoryError("extensions root must be a regular directory")

        items: list[ExtensionInventoryItem] = []
        inspected_paths: set[Path] = set()
        for package_dir in sorted(
            self._extensions_root.iterdir(),
            key=lambda path: path.name,
        ):
            if package_dir.name.startswith(".") or not (
                package_dir.is_dir() or package_dir.is_symlink()
            ):
                continue
            inspected_paths.add(package_dir)
            items.append(
                self._inspect_package(
                    package_dir,
                    approvals,
                    force_digest=force_digest,
                )
            )

        stale_cache_paths = set(self._digest_cache) - inspected_paths
        for stale_path in stale_cache_paths:
            del self._digest_cache[stale_path]
        return items

    def approve(self, extension_id: str, expected_digest: str) -> ExtensionApproval:
        item = self.prepare_approval(extension_id, expected_digest)
        assert item.manifest is not None
        return self._approval_store.approve(
            extension_id,
            expected_digest,
            item.manifest.version,
        )

    def prepare_approval(
        self,
        extension_id: str,
        expected_digest: str,
    ) -> ExtensionInventoryItem:
        """Force-hash and return a package only if it matches user intent."""

        item = self.get_item(extension_id, force_digest=True)
        if item.digest != expected_digest:
            raise ExtensionInventoryError(
                f"extension '{extension_id}' changed before approval"
            )
        if (
            item.manifest is not None
            and item.manifest.vlo is not None
            and VLO_APPLICATION_VERSION is not None
            and not is_stable_semver_range_compatible(
                item.manifest.vlo,
                VLO_APPLICATION_VERSION,
            )
        ):
            raise ExtensionInventoryError(
                f"extension '{extension_id}' VLO range does not include host "
                f"application {VLO_APPLICATION_VERSION}"
            )
        return item

    def get_item(
        self,
        extension_id: str,
        *,
        force_digest: bool = False,
    ) -> ExtensionInventoryItem:
        if (
            len(extension_id) > 128
            or not _EXTENSION_ID_PATTERN.fullmatch(extension_id)
        ):
            raise ExtensionInventoryError(f"extension '{extension_id}' was not found")

        approvals = self._approval_store.list()
        if not self._extensions_root.exists():
            raise ExtensionInventoryError(f"extension '{extension_id}' was not found")
        if self._extensions_root.is_symlink() or not self._extensions_root.is_dir():
            raise ExtensionInventoryError("extensions root must be a regular directory")

        package_dir = self._extensions_root / extension_id
        if not (package_dir.is_dir() or package_dir.is_symlink()):
            self._digest_cache.pop(package_dir, None)
            raise ExtensionInventoryError(f"extension '{extension_id}' was not found")

        item = self._inspect_package(
            package_dir,
            approvals,
            force_digest=force_digest,
        )
        if item.status == "invalid" or item.manifest is None or item.digest is None:
            raise ExtensionInventoryError(f"extension '{extension_id}' is invalid")
        return item

    def require_approved_digest(
        self,
        extension_id: str,
        digest: str,
    ) -> ExtensionInventoryItem:
        item = self.get_item(extension_id)
        if item.status != "approved" or item.digest != digest:
            raise ExtensionInventoryError(
                f"extension '{extension_id}' is not approved for digest '{digest}'"
            )
        return item

    def disable(self, extension_id: str) -> bool:
        return self._approval_store.disable(extension_id)

    def revoke(self, extension_id: str) -> bool:
        return self._approval_store.revoke(extension_id)

    def _inspect_package(
        self,
        package_dir: Path,
        approvals: dict[str, ExtensionApproval],
        *,
        force_digest: bool,
    ) -> ExtensionInventoryItem:
        errors: list[str] = []
        manifest: ExtensionManifest | None = None
        digest: str | None = None
        extension_id = package_dir.name

        if package_dir.is_symlink():
            errors.append("extension package directory cannot be a symbolic link")
        else:
            try:
                manifest = load_extension_manifest(package_dir / "manifest.json")
            except ExtensionManifestError as exc:
                errors.append(str(exc))

        if manifest is not None:
            if manifest.id != package_dir.name:
                errors.append(
                    "manifest extension ID must match its package directory name"
                )
            else:
                extension_id = manifest.id
            errors.extend(self._validate_entry_artifacts(package_dir, manifest))

        if not errors:
            try:
                digest = self._get_package_digest(
                    package_dir,
                    force=force_digest,
                )
            except (OSError, UnsafeExtensionPackageError) as exc:
                errors.append(str(exc))
                self._digest_cache.pop(package_dir, None)

        approval = approvals.get(extension_id)
        status = self._resolve_status(errors, digest, approval)
        return ExtensionInventoryItem(
            extension_id=extension_id,
            package_dir=package_dir,
            manifest=manifest,
            digest=digest,
            status=status,
            errors=tuple(errors),
            approval=approval,
        )

    def _get_package_digest(self, package_dir: Path, *, force: bool) -> str:
        snapshot = inspect_package_snapshot(package_dir)
        cached = self._digest_cache.get(package_dir)
        if not force and cached is not None and cached.snapshot == snapshot:
            return cached.digest

        digest = compute_package_digest(package_dir)
        final_snapshot = inspect_package_snapshot(package_dir)
        if final_snapshot != snapshot:
            raise UnsafeExtensionPackageError(
                "package changed while its digest cache was being refreshed"
            )
        self._digest_cache[package_dir] = _CachedPackageDigest(
            snapshot=final_snapshot,
            digest=digest,
        )
        return digest

    @staticmethod
    def _validate_entry_artifacts(
        package_dir: Path,
        manifest: ExtensionManifest,
    ) -> list[str]:
        errors: list[str] = []
        if manifest.frontend is not None:
            frontend_entry = package_dir.joinpath(*manifest.frontend.entry.split("/"))
            if frontend_entry.is_symlink() or not frontend_entry.is_file():
                errors.append(
                    f"frontend entry does not exist as a regular file: {manifest.frontend.entry}"
                )

        if manifest.backend is not None:
            module_file, package_init = backend_entry_candidates(
                package_dir,
                manifest.backend.entry,
            )
            candidates = (module_file, package_init)
            if not any(
                candidate.is_file() and not candidate.is_symlink()
                for candidate in candidates
            ):
                errors.append(
                    f"backend entry module does not exist: {manifest.backend.entry}"
                )
        return errors

    @staticmethod
    def _resolve_status(
        errors: list[str],
        digest: str | None,
        approval: ExtensionApproval | None,
    ) -> ExtensionInventoryStatus:
        if errors or digest is None:
            return "invalid"
        if approval is None:
            return "pending_approval"
        if approval.digest != digest:
            return "changed"
        if not approval.enabled:
            return "disabled"
        return "approved"
