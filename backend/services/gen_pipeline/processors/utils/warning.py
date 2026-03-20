from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PipelineWarning:
    """Structured warning produced by pipeline processors.

    All warnings share a code and message.  Optional fields provide
    context about which node or parameter triggered the warning.
    """

    code: str
    message: str
    node_id: str | None = None
    details: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to the dict shape expected by downstream consumers."""
        result: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
        }
        if self.node_id is not None:
            result["node_id"] = self.node_id
        if self.details is not None:
            result["details"] = self.details
        return result


def pipeline_warning(
    code: str,
    message: str,
    *,
    node_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a warning dict with the standard pipeline warning shape."""
    return PipelineWarning(
        code=code,
        message=message,
        node_id=node_id,
        details=details,
    ).to_dict()
