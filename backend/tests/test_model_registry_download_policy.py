"""Workflow graphs are untrusted input, so the URLs they declare are checked
against the same allow-list ComfyUI applies in missingModelDownload.ts."""


import pytest

from services.model_registry import (
    _extract_workflow_models,
    is_downloadable_model_url,
)


def _graph(name: str, url: str, directory: str = "checkpoints") -> dict:
    return {
        "nodes": [
            {"properties": {"models": [{"name": name, "url": url, "directory": directory}]}}
        ]
    }


@pytest.mark.parametrize(
    "url",
    [
        "https://huggingface.co/acme/repo/resolve/main/model.safetensors",
        "https://civitai.com/api/download/models/12345",
        "https://civitai.red/api/download/models/12345",
        "http://localhost:8188/models/model.safetensors",
    ],
)
def test_allowed_sources_are_downloadable(url):
    assert is_downloadable_model_url(url, "model.safetensors")


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/model.safetensors",
        "https://github.com/acme/repo/releases/download/v1/model.safetensors",
        # Host-prefix look-alikes must not slip past the allow-list.
        "https://huggingface.co.evil.com/acme/model.safetensors",
        "https://civitai.com.evil.com/model.safetensors",
        # Non-http schemes.
        "file:///etc/passwd",
        "ftp://huggingface.co/acme/model.safetensors",
        "",
    ],
)
def test_disallowed_sources_are_rejected(url):
    assert not is_downloadable_model_url(url, "model.safetensors")


@pytest.mark.parametrize("suffix", [".safetensors", ".sft", ".ckpt", ".pth", ".pt"])
def test_allowed_suffixes(suffix):
    url = f"https://huggingface.co/acme/repo/resolve/main/model{suffix}"
    assert is_downloadable_model_url(url, f"model{suffix}")


@pytest.mark.parametrize("suffix", [".bin", ".onnx", ".gguf", ".py", ".sh", ""])
def test_scannable_but_undownloadable_suffixes_are_rejected(suffix):
    url = f"https://huggingface.co/acme/repo/resolve/main/model{suffix}"
    assert not is_downloadable_model_url(url, f"model{suffix}")


def test_whitelisted_urls_bypass_source_and_suffix_checks():
    assert is_downloadable_model_url(
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        "RealESRGAN_x4plus.pth",
    )
    assert is_downloadable_model_url(
        "https://huggingface.co/TencentARC/T2I-Adapter/resolve/main/models/"
        "t2iadapter_depth_sd14v1.pth?download=true",
        "t2iadapter_depth_sd14v1.pth",
    )


def test_extract_workflow_models_drops_disallowed_urls():
    assert _extract_workflow_models(
        _graph("model.safetensors", "https://evil.example.com/model.safetensors")
    ) == []


def test_extract_workflow_models_drops_disallowed_suffixes():
    assert _extract_workflow_models(
        _graph("payload.sh", "https://huggingface.co/acme/repo/resolve/main/payload.sh")
    ) == []


def test_extract_workflow_models_keeps_allowed_models():
    models = _extract_workflow_models(
        _graph(
            "model.safetensors",
            "https://huggingface.co/acme/repo/resolve/main/model.safetensors",
        )
    )

    assert [model["key"] for model in models] == ["checkpoints:model.safetensors"]


def test_extract_workflow_models_checks_the_normalized_filename():
    """A path-shaped name is normalized to its basename before the suffix check,
    so the suffix cannot be smuggled in via a directory segment."""
    assert _extract_workflow_models(
        _graph(
            "model.safetensors/payload.sh",
            "https://huggingface.co/acme/repo/resolve/main/payload.sh",
        )
    ) == []
