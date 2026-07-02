import asyncio
import json
import logging

import httpx
from urllib.parse import urlparse

from config import COMFYUI_URL, RUNTIME_ROOT

logger = logging.getLogger(__name__)

# Persisted override so a URL configured through /comfy/config survives
# backend restarts (previously it silently reverted to the env default).
_URL_OVERRIDE_PATH = RUNTIME_ROOT / "comfyui_url.json"

# Grace period before closing a replaced HTTP client so in-flight proxied
# requests and generations against the old upstream can finish.
_CLIENT_CLOSE_GRACE_SECONDS = 30.0

_http_client: httpx.AsyncClient | None = None


def _load_persisted_url() -> str | None:
    try:
        payload = json.loads(_URL_OVERRIDE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    url = payload.get("comfyui_url") if isinstance(payload, dict) else None
    return url if isinstance(url, str) and url.strip() else None


def _persist_url(url: str) -> None:
    try:
        _URL_OVERRIDE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _URL_OVERRIDE_PATH.write_text(
            json.dumps({"comfyui_url": url}, indent=2),
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning("Failed to persist ComfyUI URL override: %s", exc)


_comfyui_url: str = _load_persisted_url() or COMFYUI_URL


def get_comfyui_url() -> str:
    return _comfyui_url


def validate_comfyui_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if not url:
        raise ValueError("ComfyUI URL is required")

    if "://" not in url:
        url = f"http://{url}"

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("ComfyUI URL must use http or https")
    if not parsed.netloc:
        raise ValueError("ComfyUI URL must include a host")

    return url


def get_comfyui_url_error() -> str | None:
    try:
        validate_comfyui_url(_comfyui_url)
    except ValueError as exc:
        return str(exc)
    return None


async def _close_client_after_grace(client: httpx.AsyncClient) -> None:
    try:
        await asyncio.sleep(_CLIENT_CLOSE_GRACE_SECONDS)
        if not client.is_closed:
            await client.aclose()
    except Exception:
        pass


async def set_comfyui_url(new_url: str) -> str:
    global _comfyui_url, _http_client
    url = validate_comfyui_url(new_url)
    _comfyui_url = url
    _persist_url(url)

    # Detach the old client and close it after a grace period rather than
    # yanking it out from under in-flight requests.
    old_client = _http_client
    _http_client = None
    if old_client is not None and not old_client.is_closed:
        asyncio.create_task(_close_client_after_grace(old_client))
    return _comfyui_url


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    validate_comfyui_url(_comfyui_url)
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            base_url=_comfyui_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    return _http_client


async def close_http_client():
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None
