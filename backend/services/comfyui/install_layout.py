"""Where a configured ComfyUI directory's checkout actually is.

Kept apart from local_runtime so that modules local_runtime itself depends on,
such as the node-pack version check, can resolve installs without a cycle.
"""

from __future__ import annotations

from pathlib import Path


def _candidate_install_paths(path: Path) -> list[Path]:
    expanded = path.expanduser()
    candidates = [expanded]
    nested = expanded / "ComfyUI"
    if nested != expanded:
        candidates.append(nested)
    return candidates


def resolve_comfyui_install_path(path: str | Path) -> Path | None:
    """The ComfyUI checkout a configured directory refers to, if any.

    Accepts the checkout itself or a folder holding it as ``ComfyUI/`` — the
    layout of the Windows portable bundle — and stats only, so it is cheap
    enough for polled status routes.
    """

    return next(
        (
            candidate
            for candidate in _candidate_install_paths(Path(path))
            if (candidate / "main.py").is_file()
        ),
        None,
    )
