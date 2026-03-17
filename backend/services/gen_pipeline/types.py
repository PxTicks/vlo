from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class ProcessorMeta:
    """Self-documenting metadata for a pipeline processor."""

    name: str
    """Unique processor name, e.g. 'inject_values'."""

    reads: tuple[str, ...]
    """Context fields this processor reads."""

    writes: tuple[str, ...]
    """Context fields this processor writes or mutates."""

    description: str
    """Human-readable description of what this processor does."""


@dataclass
class ProcessorDescription:
    """Output of describe_processors() — describes a processor's role and activation state."""

    name: str
    description: str
    reads: tuple[str, ...]
    writes: tuple[str, ...]
    active: bool


@runtime_checkable
class Processor(Protocol):
    """Protocol for a pipeline processor.

    Each processor has metadata describing its inputs/outputs,
    an activation check, and an execute method that operates
    on the pipeline context.
    """

    meta: ProcessorMeta

    def is_active(self, ctx: Any) -> bool:
        """Returns True if this processor should run given the current context."""
        ...

    async def execute(self, ctx: Any) -> None:
        """Executes the processor, reading from and writing to the context."""
        ...
