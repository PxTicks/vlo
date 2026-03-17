from __future__ import annotations

import logging
from typing import Any, Sequence

from services.gen_pipeline.types import Processor, ProcessorDescription

log = logging.getLogger(__name__)


async def run_processors(
    processors: Sequence[Processor],
    ctx: Any,
) -> None:
    """Run an ordered list of processors against a shared context.

    Each processor checks its own activation condition via ``is_active()``.
    If active, its ``execute()`` is called — it reads from and writes to
    the context.  Processors run sequentially in the order provided.
    """
    for processor in processors:
        if not processor.is_active(ctx):
            log.debug(
                "[pipeline] Skipping processor %s (not active)",
                processor.meta.name,
            )
            continue
        log.info("[pipeline] Running processor: %s", processor.meta.name)
        await processor.execute(ctx)


def describe_processors(
    processors: Sequence[Processor],
    ctx: Any,
) -> list[ProcessorDescription]:
    """Describe which processors would run for a given context, without executing them.

    Returns metadata for every processor in the list, with an ``active`` flag
    indicating whether it would run.  Useful for debugging, logging, and
    transparency about the pipeline's behavior for a particular workflow+rules.
    """
    return [
        ProcessorDescription(
            name=processor.meta.name,
            description=processor.meta.description,
            reads=processor.meta.reads,
            writes=processor.meta.writes,
            active=processor.is_active(ctx),
        )
        for processor in processors
    ]
