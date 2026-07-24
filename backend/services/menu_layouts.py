"""Cross-project persistence for user-customized shell menu trees."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any, TypedDict

from config import RUNTIME_ROOT

STORE_VERSION = 1
CUSTOMIZATION_VERSION = 1
MENU_LAYOUTS_PATH = RUNTIME_ROOT / "menu_layouts.json"
MENU_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$")
ITEM_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
_STORE_LOCK = Lock()


class MenuLayoutConflictError(Exception):
    """Raised when a client attempts to overwrite a newer revision."""


class MenuLayoutRecord(TypedDict):
    revision: int
    customization: dict[str, Any] | None


def validate_menu_id(menu_id: str) -> None:
    if not MENU_ID_PATTERN.fullmatch(menu_id) or "." not in menu_id:
        raise ValueError("Invalid menu layout ID")


def _require_item_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ITEM_ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must be a valid item ID")
    return value


def _require_label(value: Any, field: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80:
        raise ValueError(f"{field} must contain 1-80 characters")
    return value.strip()


def _require_order(value: Any, field: str) -> float | int:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{field} must be numeric")
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"{field} must be finite")
    return value


def _validate_parent_id(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _require_item_id(value, field)


def _validate_node(raw: Any, field: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    node_id = _require_item_id(raw.get("id"), f"{field}.id")
    kind = raw.get("kind")
    if kind not in {"category", "folder"}:
        raise ValueError(f"{field}.kind must be category or folder")
    return {
        "id": node_id,
        "kind": kind,
        "label": _require_label(raw.get("label"), f"{field}.label"),
        "parentId": _validate_parent_id(raw.get("parentId"), f"{field}.parentId"),
        "order": _require_order(raw.get("order"), f"{field}.order"),
    }


def _validate_leaf_placement(raw: Any, field: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return {
        "leafId": _require_item_id(raw.get("leafId"), f"{field}.leafId"),
        "parentId": _validate_parent_id(raw.get("parentId"), f"{field}.parentId"),
        "order": _require_order(raw.get("order"), f"{field}.order"),
    }


def validate_customization(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("version") != CUSTOMIZATION_VERSION:
        raise ValueError("Menu layout customization must use version 1")

    raw_custom_nodes = raw.get("customNodes")
    raw_overrides = raw.get("nodeOverrides")
    raw_placements = raw.get("leafPlacements")
    if (
        not isinstance(raw_custom_nodes, list)
        or not isinstance(raw_overrides, list)
        or not isinstance(raw_placements, list)
    ):
        raise ValueError(
            "Menu layout customization arrays are missing or invalid"
        )

    custom_nodes: list[dict[str, Any]] = []
    custom_node_ids: set[str] = set()
    for index, raw_node in enumerate(raw_custom_nodes):
        node = _validate_node(raw_node, f"customNodes[{index}]")
        if node["id"] in custom_node_ids:
            raise ValueError(f"Duplicate custom node '{node['id']}'")
        custom_node_ids.add(node["id"])
        custom_nodes.append(node)

    # Custom nodes form a self-contained valid graph. References to default
    # nodes are allowed and validated by the shell against the registered tree.
    custom_by_id = {node["id"]: node for node in custom_nodes}
    for node in custom_nodes:
        parent = custom_by_id.get(node["parentId"])
        if parent and node["kind"] == "category" and parent["kind"] == "category":
            raise ValueError("A category cannot be nested beneath a category")
        visited = {node["id"]}
        parent_id = node["parentId"]
        while parent_id in custom_by_id:
            if parent_id in visited:
                raise ValueError("Custom menu nodes cannot form a cycle")
            visited.add(parent_id)
            parent_id = custom_by_id[parent_id]["parentId"]

    node_overrides: list[dict[str, Any]] = []
    override_ids: set[str] = set()
    for index, raw_override in enumerate(raw_overrides):
        field = f"nodeOverrides[{index}]"
        if not isinstance(raw_override, dict):
            raise ValueError(f"{field} must be an object")
        node_id = _require_item_id(raw_override.get("id"), f"{field}.id")
        if node_id in override_ids:
            raise ValueError(f"Duplicate node override '{node_id}'")
        override: dict[str, Any] = {"id": node_id}
        if "label" in raw_override:
            override["label"] = _require_label(
                raw_override["label"], f"{field}.label"
            )
        if "parentId" in raw_override:
            override["parentId"] = _validate_parent_id(
                raw_override["parentId"], f"{field}.parentId"
            )
        if "order" in raw_override:
            override["order"] = _require_order(
                raw_override["order"], f"{field}.order"
            )
        if "deleted" in raw_override:
            if not isinstance(raw_override["deleted"], bool):
                raise ValueError(f"{field}.deleted must be boolean")
            override["deleted"] = raw_override["deleted"]
        override_ids.add(node_id)
        node_overrides.append(override)

    leaf_placements: list[dict[str, Any]] = []
    leaf_ids: set[str] = set()
    for index, raw_placement in enumerate(raw_placements):
        placement = _validate_leaf_placement(
            raw_placement, f"leafPlacements[{index}]"
        )
        if placement["leafId"] in leaf_ids:
            raise ValueError(
                f"Duplicate leaf placement '{placement['leafId']}'"
            )
        leaf_ids.add(placement["leafId"])
        leaf_placements.append(placement)

    return {
        "version": CUSTOMIZATION_VERSION,
        "customNodes": custom_nodes,
        "nodeOverrides": node_overrides,
        "leafPlacements": leaf_placements,
    }


def _empty_store() -> dict[str, Any]:
    return {"version": STORE_VERSION, "menus": {}}


def _read_store() -> dict[str, Any]:
    try:
        raw = json.loads(MENU_LAYOUTS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty_store()
    if (
        not isinstance(raw, dict)
        or raw.get("version") != STORE_VERSION
        or not isinstance(raw.get("menus"), dict)
    ):
        return _empty_store()
    return raw


def _write_store(store: dict[str, Any]) -> None:
    MENU_LAYOUTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=f".{MENU_LAYOUTS_PATH.name}.",
        suffix=".tmp",
        dir=MENU_LAYOUTS_PATH.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(store, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, MENU_LAYOUTS_PATH)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def _read_record(store: dict[str, Any], menu_id: str) -> MenuLayoutRecord:
    """Reads a stored record while preserving valid revision history.

    A corrupt or future customization is omitted, but its numeric revision is
    still returned. The client can recover by saving against that revision
    without resetting the token and allowing an older writer to pass an ABA
    revision check.
    """
    raw_record = store["menus"].get(menu_id)
    if not isinstance(raw_record, dict):
        return {"revision": 0, "customization": None}
    revision = raw_record.get("revision")
    customization = raw_record.get("customization")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return {"revision": 0, "customization": None}
    try:
        normalized = validate_customization(customization)
    except ValueError:
        return {"revision": revision, "customization": None}
    return {"revision": revision, "customization": normalized}


def get_menu_layout(menu_id: str) -> MenuLayoutRecord:
    validate_menu_id(menu_id)
    with _STORE_LOCK:
        return _read_record(_read_store(), menu_id)


def put_menu_layout(
    menu_id: str,
    customization: Any,
    base_revision: int,
) -> MenuLayoutRecord:
    validate_menu_id(menu_id)
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        raise ValueError("baseRevision must be an integer")
    normalized = validate_customization(customization)

    with _STORE_LOCK:
        store = _read_store()
        current_revision = _read_record(store, menu_id)["revision"]
        if current_revision != base_revision:
            raise MenuLayoutConflictError(
                f"Menu layout revision is {current_revision}, not {base_revision}"
            )
        record: MenuLayoutRecord = {
            "revision": current_revision + 1,
            "customization": normalized,
        }
        store["menus"][menu_id] = record
        _write_store(store)
        return record


def delete_menu_layout(menu_id: str) -> MenuLayoutRecord:
    validate_menu_id(menu_id)
    with _STORE_LOCK:
        store = _read_store()
        if menu_id in store["menus"]:
            del store["menus"][menu_id]
            _write_store(store)
    return {"revision": 0, "customization": None}
