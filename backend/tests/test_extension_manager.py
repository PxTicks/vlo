from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import services.extensions.manager as extension_manager_module
import services.extensions.package_digest as package_digest_module
from services.extensions import (
    ExtensionApprovalStateError,
    ExtensionApprovalStore,
    ExtensionInventoryError,
    ExtensionManager,
    UnsafeExtensionPackageError,
    compute_package_digest,
    is_extension_sdk_compatible,
    load_extension_manifest,
)


def _write_manifest(package_dir: Path, manifest: dict[str, object]) -> None:
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )


def _frontend_manifest(extension_id: str) -> dict[str, object]:
    return {
        "manifestVersion": 1,
        "id": extension_id,
        "name": "Test Extension",
        "version": "1.2.3",
        "sdk": ">=1.0.0 <2.0.0",
        "frontend": {"entry": "frontend/dist/index.js"},
        "capabilities": ["timeline.read"],
    }


def _create_frontend_package(root: Path, extension_id: str) -> Path:
    package_dir = root / extension_id
    _write_manifest(package_dir, _frontend_manifest(extension_id))
    entry = package_dir / "frontend" / "dist" / "index.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("export function activate() {}\n", encoding="utf-8")
    return package_dir


def _create_manager(tmp_path: Path) -> tuple[ExtensionManager, Path, Path]:
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    state_path = tmp_path / "state" / "approvals.json"
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_path, now=lambda: 1234.5),
    )
    return manager, extensions_root, state_path


def test_scan_discovers_valid_package_without_importing_backend_code(tmp_path: Path):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    package_dir = extensions_root / "example.tracker"
    manifest = {
        "manifestVersion": 1,
        "id": "example.tracker",
        "name": "Tracker",
        "version": "1.0.0",
        "sdk": ">=1.0.0 <2.0.0",
        "backend": {
            "mode": "in_process",
            "entry": "backend.example_tracker:create_extension",
        },
        "capabilities": ["backend.jobs"],
    }
    _write_manifest(package_dir, manifest)
    module = package_dir / "backend" / "example_tracker" / "__init__.py"
    module.parent.mkdir(parents=True)
    module.write_text(
        'raise RuntimeError("scanner imported extension code")\n',
        encoding="utf-8",
    )

    items = manager.scan()

    assert len(items) == 1
    assert items[0].extension_id == "example.tracker"
    assert items[0].status == "pending_approval"
    assert items[0].digest is not None
    assert items[0].errors == ()


def test_approval_is_bound_to_current_digest_and_detects_changes(tmp_path: Path):
    manager, extensions_root, state_path = _create_manager(tmp_path)
    package_dir = _create_frontend_package(extensions_root, "example.grade")
    pending = manager.scan()[0]
    assert pending.digest is not None

    approval = manager.approve("example.grade", pending.digest)
    approved = manager.scan()[0]

    assert approved.status == "approved"
    assert approved.is_approved_for_activation is True
    assert approval.approved_at == 1234.5
    assert state_path.parent != package_dir

    (package_dir / "frontend" / "dist" / "index.js").write_text(
        "export function activate() { return 2; }\n",
        encoding="utf-8",
    )
    changed = manager.scan()[0]

    assert changed.status == "changed"
    assert changed.is_approved_for_activation is False
    assert changed.digest != pending.digest


def test_approve_rejects_stale_digest(tmp_path: Path):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    _create_frontend_package(extensions_root, "example.stale")
    digest = manager.scan()[0].digest
    assert digest is not None

    entry = extensions_root / "example.stale" / "frontend" / "dist" / "index.js"
    entry.write_text("export const changed = true;\n", encoding="utf-8")

    with pytest.raises(ExtensionInventoryError, match="changed before approval"):
        manager.approve("example.stale", digest)


def test_scan_caches_unchanged_digest_but_approval_forces_byte_hash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    _create_frontend_package(extensions_root, "example.cached")
    real_compute_digest = extension_manager_module.compute_package_digest
    digest_calls = 0

    def count_digest(package_dir: Path) -> str:
        nonlocal digest_calls
        digest_calls += 1
        return real_compute_digest(package_dir)

    monkeypatch.setattr(
        extension_manager_module,
        "compute_package_digest",
        count_digest,
    )

    first = manager.scan()[0]
    second = manager.scan()[0]
    assert first.digest == second.digest
    assert digest_calls == 1

    assert first.digest is not None
    manager.approve("example.cached", first.digest)
    assert digest_calls == 2


def test_scan_invalidates_digest_cache_when_package_metadata_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    package_dir = _create_frontend_package(extensions_root, "example.changed")
    real_compute_digest = extension_manager_module.compute_package_digest
    digest_calls = 0

    def count_digest(package_path: Path) -> str:
        nonlocal digest_calls
        digest_calls += 1
        return real_compute_digest(package_path)

    monkeypatch.setattr(
        extension_manager_module,
        "compute_package_digest",
        count_digest,
    )

    first_digest = manager.scan()[0].digest
    entry = package_dir / "frontend" / "dist" / "index.js"
    entry.write_text("export const changed = 'different size';\n", encoding="utf-8")
    second_digest = manager.scan()[0].digest

    assert first_digest != second_digest
    assert digest_calls == 2


def test_get_item_inspects_only_the_requested_package(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    _create_frontend_package(extensions_root, "example.requested")
    _create_frontend_package(extensions_root, "example.unrelated")
    real_load_manifest = extension_manager_module.load_extension_manifest
    inspected_packages: list[str] = []

    def track_manifest_load(manifest_path: Path):
        inspected_packages.append(manifest_path.parent.name)
        return real_load_manifest(manifest_path)

    monkeypatch.setattr(
        extension_manager_module,
        "load_extension_manifest",
        track_manifest_load,
    )

    item = manager.get_item("example.requested")

    assert item.extension_id == "example.requested"
    assert inspected_packages == ["example.requested"]


def test_disable_and_revoke_update_inventory_fail_closed(tmp_path: Path):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    _create_frontend_package(extensions_root, "example.toggle")
    digest = manager.scan()[0].digest
    assert digest is not None
    manager.approve("example.toggle", digest)

    assert manager.disable("example.toggle") is True
    assert manager.scan()[0].status == "disabled"
    assert manager.revoke("example.toggle") is True
    assert manager.scan()[0].status == "pending_approval"


def test_package_digest_is_deterministic_and_content_sensitive(tmp_path: Path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    for package_dir, creation_order in (
        (first, ("b.txt", "a.txt")),
        (second, ("a.txt", "b.txt")),
    ):
        package_dir.mkdir()
        for file_name in creation_order:
            (package_dir / file_name).write_text(file_name, encoding="utf-8")

    first_digest = compute_package_digest(first)
    second_digest = compute_package_digest(second)

    assert first_digest == second_digest
    os.utime(first / "a.txt", (10, 10))
    assert compute_package_digest(first) == first_digest
    (first / "a.txt").write_text("changed", encoding="utf-8")
    assert compute_package_digest(first) != first_digest


def test_generated_python_cache_does_not_change_digest(tmp_path: Path):
    package_dir = tmp_path / "package"
    package_dir.mkdir()
    (package_dir / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    digest = compute_package_digest(package_dir)
    cache_dir = package_dir / "__pycache__"
    cache_dir.mkdir()
    (cache_dir / "module.pyc").write_bytes(b"generated")

    assert compute_package_digest(package_dir) == digest


def test_package_digest_rejects_symbolic_links(tmp_path: Path):
    package_dir = tmp_path / "package"
    package_dir.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("SECRET = True\n", encoding="utf-8")
    try:
        (package_dir / "linked.py").symlink_to(outside)
    except OSError:
        pytest.skip("symbolic links are not available in this test environment")

    with pytest.raises(UnsafeExtensionPackageError, match="symbolic links"):
        compute_package_digest(package_dir)


@pytest.mark.skipif(os.name == "nt", reason="Windows symlinks may require elevation")
def test_package_digest_rejects_file_swapped_to_symlink_before_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    package_dir = tmp_path / "package"
    package_dir.mkdir()
    package_file = package_dir / "module.py"
    package_file.write_text("VALUE = 'inside'\n", encoding="utf-8")
    outside = tmp_path / "outside.py"
    outside.write_text("VALUE = 'outside'\n", encoding="utf-8")
    real_open = os.open
    did_swap = False

    def swap_before_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
    ) -> int:
        nonlocal did_swap
        if Path(path) == package_file and not did_swap:
            did_swap = True
            package_file.unlink()
            package_file.symlink_to(outside)
        return real_open(path, flags, mode)

    monkeypatch.setattr(package_digest_module.os, "open", swap_before_open)

    with pytest.raises(UnsafeExtensionPackageError, match="safely open"):
        compute_package_digest(package_dir)


def test_invalid_package_does_not_hide_valid_packages(tmp_path: Path):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    _create_frontend_package(extensions_root, "example.valid")
    invalid_dir = extensions_root / "example.invalid"
    _write_manifest(invalid_dir, _frontend_manifest("different.id"))

    items = {item.extension_id: item for item in manager.scan()}

    assert items["example.valid"].status == "pending_approval"
    assert items["example.invalid"].status == "invalid"
    assert any("must match" in error for error in items["example.invalid"].errors)


@pytest.mark.parametrize(
    "entry",
    ["../outside.js", "/absolute.js", "frontend\\index.js", "source.ts"],
)
def test_manifest_rejects_unsafe_or_unbuilt_frontend_entries(
    tmp_path: Path,
    entry: str,
):
    package_dir = tmp_path / "example.invalid"
    manifest = _frontend_manifest("example.invalid")
    manifest["frontend"] = {"entry": entry}
    _write_manifest(package_dir, manifest)

    with pytest.raises(ValueError, match="manifest validation failed"):
        load_extension_manifest(package_dir / "manifest.json")


def test_manifest_rejects_duplicate_json_keys(tmp_path: Path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        '{"manifestVersion": 1, "id": "first", "id": "second"}',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicate key 'id'"):
        load_extension_manifest(manifest_path)


def test_manifest_rejects_backend_module_outside_backend_directory(
    tmp_path: Path,
):
    package_dir = tmp_path / "example.invalid-backend"
    manifest = {
        "manifestVersion": 1,
        "id": "example.invalid-backend",
        "name": "Invalid Backend",
        "version": "1.0.0",
        "sdk": ">=1.0.0 <2.0.0",
        "backend": {
            "mode": "in_process",
            "entry": "host_module:create_extension",
        },
        "capabilities": [],
    }
    _write_manifest(package_dir, manifest)

    with pytest.raises(ValueError, match="inside backend"):
        load_extension_manifest(package_dir / "manifest.json")


def test_manifest_accepts_the_shared_sdk_comparator_grammar(tmp_path: Path):
    package_dir = tmp_path / "example.compatible"
    manifest = _frontend_manifest("example.compatible")
    manifest["sdk"] = ">= 1.0.0 < 2.0.0"
    _write_manifest(package_dir, manifest)

    loaded = load_extension_manifest(package_dir / "manifest.json")

    assert loaded.sdk == ">= 1.0.0 < 2.0.0"
    assert is_extension_sdk_compatible(loaded.sdk) is True


def test_manifest_accepts_optional_vlo_range_with_shared_grammar(tmp_path: Path):
    package_dir = tmp_path / "example.raw"
    manifest = _frontend_manifest("example.raw")
    manifest["vlo"] = ">= 0.2.0 < 0.3.0"
    manifest["capabilities"] = ["host.raw"]
    _write_manifest(package_dir, manifest)

    loaded = load_extension_manifest(package_dir / "manifest.json")

    assert loaded.vlo == ">= 0.2.0 < 0.3.0"


@pytest.mark.parametrize("vlo_range", ["^0.2.0", "~0.2.0", ">=0.2"])
def test_manifest_rejects_invalid_vlo_ranges(
    tmp_path: Path,
    vlo_range: str,
):
    package_dir = tmp_path / "example.invalid-vlo"
    manifest = _frontend_manifest("example.invalid-vlo")
    manifest["vlo"] = vlo_range
    _write_manifest(package_dir, manifest)

    with pytest.raises(ValueError, match="manifest validation failed"):
        load_extension_manifest(package_dir / "manifest.json")


def test_known_incompatible_vlo_range_blocks_approval(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(extension_manager_module, "VLO_APPLICATION_VERSION", "0.2.0")
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    package_dir = _create_frontend_package(extensions_root, "example.future-vlo")
    manifest = _frontend_manifest("example.future-vlo")
    manifest["vlo"] = ">=0.3.0"
    _write_manifest(package_dir, manifest)
    item = manager.scan()[0]

    assert item.status == "pending_approval"
    assert item.digest is not None
    with pytest.raises(ExtensionInventoryError, match="does not include host"):
        manager.approve(item.extension_id, item.digest)


def test_unknown_host_version_allows_vlo_approval_with_runtime_warning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(extension_manager_module, "VLO_APPLICATION_VERSION", None)
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    package_dir = _create_frontend_package(extensions_root, "example.unknown-vlo")
    manifest = _frontend_manifest("example.unknown-vlo")
    manifest["vlo"] = ">=0.2.0 <0.3.0"
    _write_manifest(package_dir, manifest)
    item = manager.scan()[0]

    assert item.digest is not None
    manager.approve(item.extension_id, item.digest)
    assert manager.scan()[0].status == "approved"


@pytest.mark.parametrize(
    "sdk_range",
    ["^1.0.0", "~1.0.0", ">=1", "1.0.0 || 2.0.0", ">=2.0.0"],
)
def test_manifest_rejects_unsupported_or_incompatible_sdk_ranges(
    tmp_path: Path,
    sdk_range: str,
):
    package_dir = tmp_path / "example.incompatible"
    manifest = _frontend_manifest("example.incompatible")
    manifest["sdk"] = sdk_range
    _write_manifest(package_dir, manifest)

    with pytest.raises(ValueError, match="manifest validation failed"):
        load_extension_manifest(package_dir / "manifest.json")


def test_incompatible_sdk_package_is_invalid_before_approval(tmp_path: Path):
    manager, extensions_root, _state_path = _create_manager(tmp_path)
    package_dir = _create_frontend_package(
        extensions_root,
        "example.incompatible",
    )
    manifest = _frontend_manifest("example.incompatible")
    manifest["sdk"] = ">=2.0.0"
    _write_manifest(package_dir, manifest)

    item = manager.scan()[0]

    assert item.status == "invalid"
    assert item.digest is None
    assert any("does not include host SDK" in error for error in item.errors)
    with pytest.raises(ExtensionInventoryError, match="is invalid"):
        manager.get_item("example.incompatible", force_digest=True)


def test_approval_store_is_atomic_private_and_persistent(tmp_path: Path):
    state_path = tmp_path / "state" / "approvals.json"
    store = ExtensionApprovalStore(state_path, now=lambda: 42.0)
    digest = "sha256:" + "a" * 64

    store.approve("example.persisted", digest, "1.0.0")
    reloaded = ExtensionApprovalStore(state_path).get("example.persisted")

    assert reloaded is not None
    assert reloaded.digest == digest
    assert reloaded.approved_at == 42.0
    if os.name != "nt":
        assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    assert list(state_path.parent.glob("*.tmp")) == []


def test_corrupt_approval_state_prevents_inventory_scan(tmp_path: Path):
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()
    state_path = tmp_path / "state" / "approvals.json"
    state_path.parent.mkdir()
    state_path.write_text("not json", encoding="utf-8")
    manager = ExtensionManager(
        extensions_root,
        ExtensionApprovalStore(state_path),
    )

    with pytest.raises(ExtensionApprovalStateError, match="cannot read"):
        manager.scan()


def test_duplicate_approval_keys_fail_closed(tmp_path: Path):
    state_path = tmp_path / "state" / "approvals.json"
    state_path.parent.mkdir()
    state_path.write_text(
        '{"schemaVersion": 1, "schemaVersion": 1, "approvals": {}}',
        encoding="utf-8",
    )
    store = ExtensionApprovalStore(state_path)

    with pytest.raises(ExtensionApprovalStateError, match="duplicate key"):
        store.list()


def test_manager_rejects_approval_state_inside_extension_tree(tmp_path: Path):
    extensions_root = tmp_path / "extensions"
    extensions_root.mkdir()

    with pytest.raises(ExtensionInventoryError, match="outside"):
        ExtensionManager(
            extensions_root,
            ExtensionApprovalStore(extensions_root / ".state" / "approvals.json"),
        )
