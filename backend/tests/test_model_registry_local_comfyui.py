"""Workflow model downloads land in the local ComfyUI install directory, so
they are only offered when the ComfyUI we talk to is the local one. A local
install paired with a remote ComfyUI URL must not offer downloads."""

import os
import sys

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import model_registry
from services.model_registry import (
    get_available_workflow_models,
    get_workflow_download_specs,
    is_comfyui_local,
    is_comfyui_model_downloads_enabled,
    is_workflow_model_gated,
)


GRAPH = {
    "nodes": [
        {
            "properties": {
                "models": [
                    {
                        "name": "flux1-dev.safetensors",
                        "url": (
                            "https://huggingface.co/black-forest-labs/FLUX.1-dev"
                            "/resolve/main/flux1-dev.safetensors"
                        ),
                        "directory": "diffusion_models",
                    }
                ]
            }
        }
    ]
}
MODEL_KEY = "diffusion_models:flux1-dev.safetensors"


@pytest.fixture
def install_dir(tmp_path, monkeypatch):
    path = tmp_path / "ComfyUI"
    (path / "models" / "diffusion_models").mkdir(parents=True)
    monkeypatch.setattr(model_registry, "get_comfyui_install_dir", lambda: path)
    return path


def _set_url(monkeypatch, url: str) -> None:
    monkeypatch.setattr(model_registry, "get_comfyui_url", lambda: url)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8188",
        "http://127.0.0.1:8188",
        "http://127.0.0.2:8188",
        "http://[::1]:8188",
        "https://localhost",
    ],
)
def test_loopback_urls_are_local(monkeypatch, url):
    _set_url(monkeypatch, url)
    assert is_comfyui_local()


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.50:8188",
        "https://comfy.example.com",
        "http://10.0.0.4:8188",
        # A loopback-looking hostname that does not resolve locally.
        "http://localhost.evil.com:8188",
        "",
    ],
)
def test_remote_urls_are_not_local(monkeypatch, url):
    _set_url(monkeypatch, url)
    assert not is_comfyui_local()


def test_downloads_disabled_without_an_install_dir(monkeypatch):
    monkeypatch.setattr(model_registry, "get_comfyui_install_dir", lambda: None)
    _set_url(monkeypatch, "http://127.0.0.1:8188")

    assert not is_comfyui_model_downloads_enabled()


def test_downloads_disabled_when_connected_to_a_remote_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "https://comfy.example.com")

    assert not is_comfyui_model_downloads_enabled()


def test_downloads_enabled_for_a_local_install_and_url(install_dir, monkeypatch):
    _set_url(monkeypatch, "http://127.0.0.1:8188")

    assert is_comfyui_model_downloads_enabled()


def test_no_models_are_listed_for_a_remote_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "https://comfy.example.com")

    assert get_available_workflow_models("__temp__", GRAPH) == []


def test_models_are_listed_for_a_local_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "http://127.0.0.1:8188")

    assert [m["key"] for m in get_available_workflow_models("__temp__", GRAPH)] == [
        MODEL_KEY
    ]


def test_download_specs_refuse_a_remote_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "https://comfy.example.com")

    with pytest.raises(ValueError, match="remote ComfyUI"):
        get_workflow_download_specs("__temp__", MODEL_KEY, GRAPH)


def test_download_specs_resolve_for_a_local_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "http://127.0.0.1:8188")

    specs = get_workflow_download_specs("__temp__", MODEL_KEY, GRAPH)

    assert len(specs) == 1
    assert specs[0].dest_path == str(
        install_dir / "models" / "diffusion_models" / "flux1-dev.safetensors"
    )


def test_gating_is_not_reported_for_a_remote_comfyui(install_dir, monkeypatch):
    """The model is gated, but a remote ComfyUI cannot download it at all, so
    the download is refused by specs rather than by a token prompt."""
    _set_url(monkeypatch, "https://comfy.example.com")

    assert not is_workflow_model_gated("__temp__", MODEL_KEY, GRAPH)


def test_gating_is_reported_for_a_local_comfyui(install_dir, monkeypatch):
    _set_url(monkeypatch, "http://127.0.0.1:8188")

    assert is_workflow_model_gated("__temp__", MODEL_KEY, GRAPH)
