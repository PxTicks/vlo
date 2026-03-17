import httpx
from urllib.parse import urlparse

from config import COMFYUI_URL

_http_client: httpx.AsyncClient | None = None
_comfyui_url: str = COMFYUI_URL


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


async def set_comfyui_url(new_url: str) -> str:
    global _comfyui_url
    url = validate_comfyui_url(new_url)
    _comfyui_url = url
    await close_http_client()
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
