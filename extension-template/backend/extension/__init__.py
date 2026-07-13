"""Minimal trusted backend entry point for the official extension template."""

from fastapi import APIRouter

from services.extensions import (
    BackendExtensionContext,
    BackendExtensionDefinition,
)


def create_extension(
    context: BackendExtensionContext,
) -> BackendExtensionDefinition:
    # `services.extensions` is the supported barrel. Trusted deeper imports are
    # allowed when needed, but must be version-coupled and restored in shutdown.
    router = APIRouter()

    @router.get("/status")
    def get_status() -> dict[str, str]:
        return {
            "extensionId": context.extension.id,
            "version": context.extension.version,
            "sdkVersion": context.sdk_version,
        }

    context.logger.info("Minimal backend extension activated.")

    def shutdown() -> None:
        context.logger.info("Minimal backend extension stopped.")

    return BackendExtensionDefinition(router=router, shutdown=shutdown)
