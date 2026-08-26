"""Capability providers.

Local model runtimes are registered by descriptor and share
:class:`DescriptorProvider`; the per-capability modules here hold only what a
descriptor cannot express — model discovery. A capability that does not fit the
descriptor shape (ComfyUI, which is an external service) implements
:class:`CapabilityProvider` directly, which stays a supported way to register.
"""

from .base import CapabilityProvider, ProviderReport
from .comfyui import ComfyUIProvider
from .descriptor import DescriptorProvider


__all__ = [
    "CapabilityProvider",
    "ComfyUIProvider",
    "DescriptorProvider",
    "ProviderReport",
]
