"""Prompt logging utility for manual equivalence testing.

When the environment variable ``VLO_LOG_SUBMITTED_PROMPT`` is set to ``1``,
the final prompt JSON is written to ``/tmp/vlo_prompt_{label}_{timestamp}.json``
on every generation dispatch.  This allows easy side-by-side diffing of the
old (backend-rewrite) and new (frontend pre-resolve) paths.

Usage from a processor or the dispatch phase::

    from services.gen_pipeline.processors.utils.prompt_logging import maybe_log_prompt

    maybe_log_prompt(ctx.workflow, label="old_path")
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_ENABLED_ENV_VAR = "VLO_LOG_SUBMITTED_PROMPT"


def _is_logging_enabled() -> bool:
    return os.environ.get(_ENABLED_ENV_VAR, "") == "1"


def maybe_log_prompt(
    prompt: dict[str, Any] | None,
    *,
    label: str = "prompt",
) -> Path | None:
    """Write *prompt* to ``/tmp`` when prompt logging is enabled.

    Returns the written path, or ``None`` if logging is disabled or
    *prompt* is falsy.
    """
    if not _is_logging_enabled() or not prompt:
        return None

    timestamp = int(time.time() * 1000)
    safe_label = label.replace("/", "_").replace(" ", "_")[:64]
    out_path = Path(f"/tmp/vlo_prompt_{safe_label}_{timestamp}.json")

    try:
        out_path.write_text(
            json.dumps(prompt, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        logger.info("[prompt_logging] Wrote prompt to %s", out_path)
    except OSError:
        logger.warning("[prompt_logging] Failed to write prompt to %s", out_path)
        return None

    return out_path
