"""Shared backend test configuration.

``pythonpath = ["."]`` in ``pyproject.toml`` puts the backend root on ``sys.path``,
so test modules import ``services.*`` / ``routers.*`` / ``main`` directly. No
per-file ``sys.path`` manipulation is needed.
"""

from __future__ import annotations

import pytest


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    """Run every ``@pytest.mark.anyio`` test on the asyncio backend."""
    return "asyncio"
