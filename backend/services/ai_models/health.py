from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass


HealthPayload = Mapping[str, object]
ModelInventory = Iterable[Mapping[str, object]]


@dataclass(frozen=True)
class AppStatusProvider:
    response_key: str
    health_fn: Callable[[], HealthPayload]
    unavailable_message: str
    use_runtime_error: bool = False
    installed_models_fn: Callable[[], ModelInventory] | None = None

    def _has_installed_model(self) -> bool:
        if self.installed_models_fn is None:
            return False

        return any(bool(model.get("installed")) for model in self.installed_models_fn())

    def to_app_status(self) -> dict[str, str | None]:
        try:
            health = self.health_fn()
            runtime = health.get("runtime")
            runtime_payload = runtime if isinstance(runtime, Mapping) else {}
            ready = bool(runtime_payload.get("ready"))
            if ready or self._has_installed_model():
                return {"status": "available", "error": None}

            error = self.unavailable_message
            if self.use_runtime_error:
                runtime_error = runtime_payload.get("error")
                if isinstance(runtime_error, str) and runtime_error:
                    error = runtime_error
            return {"status": "unavailable", "error": error}
        except Exception as exc:  # pragma: no cover - defensive status fallback
            return {"status": "unavailable", "error": str(exc)}
