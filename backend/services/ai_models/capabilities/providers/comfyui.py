"""ComfyUI capability provider (configuration only).

ComfyUI is an external service rather than an in-process runtime, so the only
cheap thing to establish is that it is configured coherently. Reachability is a
network round-trip and therefore belongs to the load/operational stages, not to
a status request — ``/app/status`` already pays for that call once.
"""

from __future__ import annotations

from pathlib import Path

from ..contract import (
    Check,
    CheckStatus,
    FailureCode,
    Remediation,
    RemediationKind,
    VerificationStage,
)
from ..environment import display_path
from ..failures import sanitize_message, sanitize_url
from .base import CapabilityProvider, ProviderReport


CAPABILITY_ID = "comfyui"

SETTINGS_REMEDIATION = Remediation(
    kind=RemediationKind.SETTINGS,
    summary="Set COMFYUI_URL to the address ComfyUI is serving on",
    command="COMFYUI_URL=http://127.0.0.1:8188",
    requires_restart=True,
)


class ComfyUIProvider(CapabilityProvider):
    id = CAPABILITY_ID
    label = "ComfyUI"

    def inspect(self, *, deep_probe: bool = True) -> ProviderReport:
        # ComfyUI has no local runtime to import, so the switch changes
        # nothing here; it exists to satisfy the provider contract.
        del deep_probe

        from config import COMFYUI_INSTALL_DIR
        from services.comfyui.comfyui_client import (
            get_comfyui_url,
            get_comfyui_url_error,
        )

        url_error = get_comfyui_url_error()
        if url_error:
            url_check = Check(
                id="config.url",
                status=CheckStatus.FAIL,
                stage=VerificationStage.DISCOVERED,
                code=FailureCode.CONFIG_MISSING,
                summary="The configured ComfyUI URL is not usable",
                detail=sanitize_message(url_error),
                remediation=SETTINGS_REMEDIATION,
            )
        else:
            url_check = Check(
                id="config.url",
                status=CheckStatus.PASS,
                stage=VerificationStage.DISCOVERED,
                summary=f"ComfyUI is configured at {sanitize_url(get_comfyui_url())}",
            )

        return ProviderReport(
            checks=(url_check, self._install_dir_check(COMFYUI_INSTALL_DIR)),
            expected=True,
        )

    def _install_dir_check(self, install_dir: Path | None) -> Check:
        if install_dir is None:
            # Not applicable rather than unchecked: ComfyUI is reached over
            # HTTP, and no local install directory is a complete answer.
            return Check(
                id="install.directory",
                status=CheckStatus.PASS,
                summary="ComfyUI is used as an external service",
            )
        if not install_dir.is_dir():
            return Check(
                id="install.directory",
                status=CheckStatus.WARN,
                code=FailureCode.CONFIG_MISSING,
                summary="COMFYUI_INSTALL_DIR does not point at a directory",
                detail=display_path(install_dir),
            )
        return Check(
            id="install.directory",
            status=CheckStatus.PASS,
            summary="The local ComfyUI install directory exists",
            detail=display_path(install_dir),
        )
