from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass


HealthPayload = Mapping[str, object]


@dataclass(frozen=True)
class AppStatusProvider:
    response_key: str
    health_fn: Callable[[], HealthPayload]
    unavailable_message: str
    use_runtime_error: bool = False

    def to_app_status(self) -> dict[str, str | None]:
        try:
            health = self.health_fn()
            runtime = health.get("runtime")
            runtime_payload = runtime if isinstance(runtime, Mapping) else {}
            ready = bool(runtime_payload.get("ready"))
            if ready:
                return {"status": "available", "error": None}

            error = self.unavailable_message
            if self.use_runtime_error:
                runtime_error = runtime_payload.get("error")
                if isinstance(runtime_error, str) and runtime_error:
                    error = runtime_error
            return {"status": "unavailable", "error": error}
        except Exception as exc:  # pragma: no cover - defensive status fallback
            return {"status": "unavailable", "error": str(exc)}

