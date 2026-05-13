"""Tests for the gated-model detection used by the workflow download flow."""

import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.model_registry import (
    _extract_workflow_models,
    _gated_repo_url_for,
    _is_gated_flux_url,
)


def _make_node(models: list[dict]) -> dict:
    return {"properties": {"models": models}}


def test_is_gated_flux_url_matches_flux_1_dev():
    assert _is_gated_flux_url(
        "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
    )


def test_is_gated_flux_url_matches_flux_2_klein_9b():
    assert _is_gated_flux_url(
        "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors"
    )


def test_is_gated_flux_url_excepts_flux_1_schnell():
    assert not _is_gated_flux_url(
        "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/flux1-schnell.safetensors"
    )


def test_is_gated_flux_url_excepts_flux_2_klein_4b():
    assert not _is_gated_flux_url(
        "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b/resolve/main/flux-2-klein-base-4b.safetensors"
    )
    assert not _is_gated_flux_url(
        "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b-fp8/resolve/main/flux-2-klein-base-4b-fp8.safetensors"
    )


def test_is_gated_flux_url_ignores_non_bfl_repos():
    assert not _is_gated_flux_url(
        "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors"
    )


def test_is_gated_flux_url_ignores_non_huggingface_hosts():
    assert not _is_gated_flux_url(
        "https://example.com/black-forest-labs/FLUX.1-dev/resolve/main/flux.safetensors"
    )


def test_gated_repo_url_strips_path_to_repo_root():
    assert (
        _gated_repo_url_for(
            "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux.safetensors"
        )
        == "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8"
    )


def test_extract_workflow_models_marks_gated_and_repo_url():
    workflow = {
        "nodes": [
            _make_node(
                [
                    {
                        "name": "flux-2-klein-base-9b-fp8.safetensors",
                        "url": "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors",
                        "directory": "diffusion_models",
                    },
                    {
                        "name": "qwen_3_8b_fp8mixed.safetensors",
                        "url": "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors",
                        "directory": "text_encoders",
                    },
                ]
            ),
        ],
    }

    models = {model["filename"]: model for model in _extract_workflow_models(workflow)}

    flux_model = models["flux-2-klein-base-9b-fp8.safetensors"]
    assert flux_model["gated"] is True
    assert (
        flux_model["gatedRepoUrl"]
        == "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8"
    )

    qwen_model = models["qwen_3_8b_fp8mixed.safetensors"]
    assert qwen_model["gated"] is False
    assert qwen_model["gatedRepoUrl"] is None
