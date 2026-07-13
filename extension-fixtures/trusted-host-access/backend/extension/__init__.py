"""Backend half of the trusted-host authority conformance fixture."""

from __future__ import annotations

import logging

from fastapi import APIRouter

from services.extensions import BackendExtensionContext, BackendExtensionDefinition
# Trusted fallback: this deeper import is intentionally coupled to VLO 0.2.x.
from services.extensions.host_version import VLO_APPLICATION_VERSION


class _FixtureDiagnosticFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.vlo_trusted_fixture = True
        return True


def create_extension(
    context: BackendExtensionContext,
) -> BackendExtensionDefinition:
    router = APIRouter()
    diagnostic_filter = _FixtureDiagnosticFilter()
    context.logger.logger.addFilter(diagnostic_filter)

    @router.get("/host-version")
    def get_host_version() -> dict[str, str | None]:
        return {"vloVersion": VLO_APPLICATION_VERSION}

    context.logger.info(
        "Trusted host fixture backend activated for VLO %s.",
        VLO_APPLICATION_VERSION or "unknown",
    )

    def shutdown() -> None:
        context.logger.logger.removeFilter(diagnostic_filter)
        context.logger.info("Trusted host fixture backend hook restored.")

    return BackendExtensionDefinition(router=router, shutdown=shutdown)
