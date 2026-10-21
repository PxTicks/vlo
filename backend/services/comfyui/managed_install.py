"""Which parts of a ComfyUI install vlo itself put there.

vlo only ever changes what it created. The installer records each custom-node
pack it clones in ``.vlo-managed.json`` at the checkout root, and an in-app
update is offered for exactly those packs. A pack the user cloned, or one that
was already present when vlo set up an environment for an existing checkout,
stays report-only.

The record lives in the ComfyUI checkout rather than in vlo's runtime folder
so that it travels with the install: a second vlo pointed at the same ComfyUI
sees the same ownership.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

logger = logging.getLogger(__name__)

MANAGED_MARKER_FILENAME = ".vlo-managed.json"
_MARKER_VERSION = 1


class ManagedNodePack(TypedDict):
    # The folder name under custom_nodes.
    directory: str
    repository: str
    clonedAt: str


def _marker_path(checkout: Path) -> Path:
    return checkout / MANAGED_MARKER_FILENAME


def read_managed_node_packs(checkout: Path) -> list[ManagedNodePack]:
    """The packs vlo recorded cloning into this checkout; empty when unknown."""

    try:
        payload = json.loads(_marker_path(checkout).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        # An unreadable record means vlo can no longer prove ownership, which
        # makes every pack report-only — the safe direction to fail in.
        logger.warning("Ignoring unreadable %s: %s", _marker_path(checkout), exc)
        return []

    entries = payload.get("nodePacks") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    return [
        {
            "directory": entry["directory"],
            "repository": entry["repository"],
            "clonedAt": str(entry.get("clonedAt", "")),
        }
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("directory"), str)
        and isinstance(entry.get("repository"), str)
    ]


def find_managed_node_pack(checkout: Path, pack_dir: Path) -> ManagedNodePack | None:
    """The record for ``pack_dir`` if vlo cloned it into this checkout."""

    if pack_dir.parent != checkout / "custom_nodes":
        return None
    return next(
        (
            entry
            for entry in read_managed_node_packs(checkout)
            if entry["directory"] == pack_dir.name
        ),
        None,
    )


def record_managed_node_pack(checkout: Path, directory: str, repository: str) -> None:
    """Note that vlo cloned ``directory`` into this checkout's custom_nodes."""

    entries = [
        entry
        for entry in read_managed_node_packs(checkout)
        if entry["directory"] != directory
    ]
    entries.append(
        {
            "directory": directory,
            "repository": repository,
            "clonedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    )
    _marker_path(checkout).write_text(
        json.dumps({"version": _MARKER_VERSION, "nodePacks": entries}, indent=2) + "\n",
        encoding="utf-8",
    )
