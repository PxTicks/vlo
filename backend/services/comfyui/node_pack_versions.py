"""Whether the configured ComfyUI carries a new enough ComfyUI-vlo.

vlo's shipped workflows call ComfyUI-vlo nodes, and the two move together: a
workflow that starts using a new node or input needs the pack release that
ships it. A missing node *class* already surfaces through the workflow
dependency warning; an old pack whose classes exist but predate an input a
workflow sets only fails inside ComfyUI's validation. This check catches both
before a generation is attempted.

It reads the pack's pyproject.toml from disk rather than asking ComfyUI, so it
works while ComfyUI is stopped (the installer runs it) and for every install
route — git clone, Comfy Registry, ComfyUI-Manager — since all of them carry
that file. It only reports: ComfyUI is a separate install, possibly running and
possibly not one vlo created, so nothing here changes it.

Run ``python -m services.comfyui.node_pack_versions`` from ``backend/`` for the
command-line report.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Literal, TypedDict

from services.comfyui.local_runtime import resolve_comfyui_install_path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10, which the installers still accept
    tomllib = None  # type: ignore[assignment]

COMFYUI_VLO_PACK_ID = "comfyui-vlo"
COMFYUI_VLO_REPOSITORY_URL = "https://github.com/PxTicks/ComfyUI-vlo"
COMFYUI_VLO_DIRECTORY_NAME = "ComfyUI-vlo"
# The oldest ComfyUI-vlo release that runs every shipped workflow. Raise it to
# the release that ships a node or input as soon as a shipped workflow starts
# relying on it, and bump the pack's own pyproject version to match.
COMFYUI_VLO_MINIMUM_VERSION = "0.3.0"
# The ComfyUI-vlo node types the shipped workflows use. Nothing reads it at
# runtime; it is the reminder for the minimum above. A test fails when a
# shipped workflow uses a vlo node missing from this set, and adding the node
# here is the moment to check whether COMFYUI_VLO_MINIMUM_VERSION has to rise.
COMFYUI_VLO_NODE_TYPES = frozenset(
    {
        "vloFeatherAudioLatentMask",
        "vloFeatherVideoLatentMask",
        "vloFillMaskedArea",
        "vloGrowMask",
        "vloLatentCompositeMasked",
        "vloListFanOut",
        "vloMaskToLatentMask",
        "vloMemoryLoadAudioBatch",
        "vloMemoryLoadImage",
        "vloMemoryLoadImageBatch",
        "vloMemoryLoadVideo",
        "vloMemoryLoadVideoBatch",
        "vloMiniMaxH3AddMaskedGuidesFromVideo",
        "vloMiniMaxH3LoraLoader",
        "vloMiniMaxH3PatchMaskedGuides",
        "vloMiniMaxH3ReferenceToVideoBatch",
        "vloSaveVideo",
        "vloSetAudioLatentBinaryMasks",
        "vloTimeToMove",
        "vloVideoConvertFps",
    }
)

NodePackStatus = Literal["ok", "outdated", "unreadable", "missing", "not_checked"]

# Worst first: with several copies installed, the report describes the one most
# likely to break a generation.
_STATUS_SEVERITY: dict[NodePackStatus, int] = {
    "missing": 0,
    "unreadable": 1,
    "outdated": 2,
    "ok": 3,
    "not_checked": 4,
}
_RELEASE_PATTERN = re.compile(r"^\s*v?(\d+(?:\.\d+)*)")
_TABLE_PATTERN = re.compile(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$")
_STRING_KEY_PATTERN = re.compile(r"""^\s*(name|version)\s*=\s*["']([^"']*)["']""")


class NodePackReport(TypedDict):
    status: NodePackStatus
    packId: str
    requiredVersion: str
    installedVersion: str | None
    # The pack folder that was judged, or None when none was found.
    path: str | None
    # A command that brings the pack up to date, when one is known. A pack
    # installed through the registry is updated from ComfyUI-Manager instead.
    updateCommand: str | None


def parse_release(version: str) -> tuple[int, ...] | None:
    """The numeric release segment of a version, ignoring any pre-release tail."""

    match = _RELEASE_PATTERN.match(version)
    if match is None:
        return None
    release = tuple(int(part) for part in match.group(1).split("."))
    # Trailing zeros carry no order, so 0.3 and 0.3.0 compare equal.
    while len(release) > 1 and release[-1] == 0:
        release = release[:-1]
    return release


def _read_project_table(pyproject_path: Path) -> dict[str, str] | None:
    try:
        text = pyproject_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    if tomllib is not None:
        try:
            project = tomllib.loads(text).get("project")
        except tomllib.TOMLDecodeError:
            return None
        if not isinstance(project, dict):
            return None
        return {
            key: value
            for key in ("name", "version")
            if isinstance(value := project.get(key), str)
        }
    return _scan_project_table(text)


def _scan_project_table(text: str) -> dict[str, str]:
    """Read [project] name and version without a TOML parser.

    Only the plain one-line string form is understood, which is how every
    pyproject.toml the Comfy Registry accepts spells them.
    """

    fields: dict[str, str] = {}
    in_project = False
    for line in text.splitlines():
        table = _TABLE_PATTERN.match(line)
        if table is not None:
            in_project = table.group(1).strip() == "project"
            continue
        if in_project and (match := _STRING_KEY_PATTERN.match(line)):
            fields.setdefault(match.group(1), match.group(2))
    return fields


def _is_inactive(entry: Path) -> bool:
    # ComfyUI skips both forms: ComfyUI-Manager disables a pack by moving it
    # under custom_nodes/.disabled/, and older Manager builds renamed it.
    return entry.name.startswith(".") or entry.name.endswith(".disabled")


def _judge_pack(pack_dir: Path, required: tuple[int, ...]) -> NodePackReport:
    project = _read_project_table(pack_dir / "pyproject.toml") or {}
    installed_version = project.get("version")
    installed = parse_release(installed_version) if installed_version else None

    if installed is None:
        # Clones from before the pack was packaged for the registry carry no
        # pyproject.toml at all; they predate every minimum vlo has declared.
        status: NodePackStatus = "unreadable"
    elif installed < required:
        status = "outdated"
    else:
        status = "ok"

    update_command = None
    if status != "ok" and (pack_dir / ".git").exists():
        update_command = f'git -C "{pack_dir}" pull --ff-only'

    return {
        "status": status,
        "packId": COMFYUI_VLO_PACK_ID,
        "requiredVersion": COMFYUI_VLO_MINIMUM_VERSION,
        "installedVersion": installed_version,
        "path": str(pack_dir),
        "updateCommand": update_command,
    }


def _find_pack_dirs(custom_nodes_dir: Path) -> list[Path]:
    pack_dirs: list[Path] = []
    for entry in sorted(custom_nodes_dir.iterdir()):
        if not entry.is_dir() or _is_inactive(entry):
            continue
        project = _read_project_table(entry / "pyproject.toml")
        if project is not None and "name" in project:
            if project["name"].casefold() == COMFYUI_VLO_PACK_ID:
                pack_dirs.append(entry)
        elif entry.name.casefold() == COMFYUI_VLO_DIRECTORY_NAME.casefold():
            # No usable pyproject.toml, so the folder name is the only clue.
            pack_dirs.append(entry)
    return pack_dirs


def _report(
    status: NodePackStatus,
    *,
    path: Path | None = None,
    update_command: str | None = None,
) -> NodePackReport:
    return {
        "status": status,
        "packId": COMFYUI_VLO_PACK_ID,
        "requiredVersion": COMFYUI_VLO_MINIMUM_VERSION,
        "installedVersion": None,
        "path": str(path) if path is not None else None,
        "updateCommand": update_command,
    }


def inspect_comfyui_vlo(install_dir: Path | None) -> NodePackReport:
    """Report the ComfyUI-vlo found under a ComfyUI install directory.

    ``install_dir`` is either the checkout or a folder holding it as
    ``ComfyUI/``, which verification and launch both accept.
    """

    checkout = (
        resolve_comfyui_install_path(install_dir) if install_dir is not None else None
    )
    if checkout is None:
        return _report("not_checked")

    custom_nodes_dir = checkout / "custom_nodes"
    clone_command = (
        f'git clone {COMFYUI_VLO_REPOSITORY_URL} '
        f'"{custom_nodes_dir / COMFYUI_VLO_DIRECTORY_NAME}"'
    )
    if not custom_nodes_dir.is_dir():
        return _report("missing", update_command=clone_command)

    try:
        pack_dirs = _find_pack_dirs(custom_nodes_dir)
    except OSError:
        return _report("not_checked")
    if not pack_dirs:
        return _report("missing", update_command=clone_command)

    required = parse_release(COMFYUI_VLO_MINIMUM_VERSION)
    assert required is not None
    reports = [_judge_pack(pack_dir, required) for pack_dir in pack_dirs]
    return min(reports, key=lambda report: _STATUS_SEVERITY[report["status"]])


def check_configured_comfyui_vlo() -> NodePackReport:
    """Report the ComfyUI-vlo of the local install serving vlo's ComfyUI URL.

    The saved install directory outlives a switch to a remote server, so it
    only describes the ComfyUI vlo talks to while that URL is local — the same
    rule that gates model downloads into the directory.
    """

    # Imported here: model_registry brings in the download services, which the
    # command-line check with an explicit --comfyui-dir never needs.
    from services.model_registry import is_comfyui_local
    from services.runtime_settings import get_comfyui_install_dir

    if not is_comfyui_local():
        return _report("not_checked")
    return inspect_comfyui_vlo(get_comfyui_install_dir())


def describe_report(report: NodePackReport) -> str:
    """A plain-text summary for terminals, ASCII so any console can print it."""

    required = report["requiredVersion"]
    installed = report["installedVersion"]
    status = report["status"]

    if status == "not_checked":
        return (
            "ComfyUI-vlo check skipped: vlo is not using a local ComfyUI install "
            "it can read."
        )
    if status == "ok":
        return f"ComfyUI-vlo {installed} is up to date (vlo needs {required} or newer)."

    if status == "missing":
        lines = [f"ComfyUI-vlo was not found. vlo's workflows need {required} or newer."]
    elif status == "unreadable":
        lines = [
            f"ComfyUI-vlo at {report['path']} has no readable version. "
            f"vlo's workflows need {required} or newer."
        ]
    else:
        lines = [
            f"ComfyUI-vlo {installed} at {report['path']} is older than the "
            f"{required} vlo's workflows need."
        ]
    if report["updateCommand"]:
        lines.append(f"  Update it with: {report['updateCommand']}")
    else:
        lines.append("  Update it from ComfyUI-Manager (Custom Nodes Manager).")
    lines.append("  Then restart ComfyUI.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report whether ComfyUI-vlo is new enough for vlo's workflows.",
    )
    parser.add_argument(
        "--comfyui-dir",
        type=Path,
        help="ComfyUI install directory. Defaults to the one in vlo's settings.",
    )
    args = parser.parse_args(argv)

    if args.comfyui_dir is not None:
        report = inspect_comfyui_vlo(args.comfyui_dir.expanduser())
    else:
        report = check_configured_comfyui_vlo()
    print(describe_report(report))
    # Always 0: this is advice printed at the end of an install, and a stale
    # node pack must not read as a failed install.
    return 0


if __name__ == "__main__":
    sys.exit(main())
