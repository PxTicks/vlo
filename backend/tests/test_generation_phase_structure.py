import json
import os
import sys
from pathlib import Path
from typing import Any, cast

import httpx

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.comfyui.comfyui_generate import finalize_backend_response  # noqa: E402
from services.gen_pipeline.context import BackendPipelineContext  # noqa: E402
from services.gen_pipeline.processors import (  # noqa: E402
    build_backend_dispatch_processors,
    build_backend_preprocessors,
    build_generation_processors,
)
from services.workflow_rules.pipeline import iter_pipeline_stages  # noqa: E402


async def _noop_upload_video_bytes(
    _client: Any,
    _video_bytes: bytes,
    _filename_value: str,
    _content_type: str,
) -> tuple[str | None, dict[str, Any] | None]:
    return None, None


async def _noop_register_media_bytes(
    _client: Any,
    _media_bytes: bytes,
    _filename_value: str,
    _content_type: str,
    _media_type: str,
    _client_id: str | None,
) -> tuple[str | None, dict[str, Any] | None]:
    return None, None


def _noop_aspect_ratio_processing(
    _workflow: dict[str, Any],
    _rules: dict[str, Any],
    _target_aspect_ratio: str | None,
    _target_resolution: Any,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    return None, []


def test_backend_generation_phase_builders_keep_dispatch_separate():
    preprocessors = build_backend_preprocessors(
        workflows_dir=Path("."),
        fallback_workflow_dirs=None,
        input_node_map={},
        analyze_mask_video_bounds_fn=lambda *_args, **_kwargs: (0, 0, 1, 1),
        crop_video_fn=lambda video_bytes, _crop: video_bytes,
        get_video_dimensions_fn=lambda _video_bytes: (1, 1),
        upload_video_bytes_fn=_noop_upload_video_bytes,
        register_media_bytes_fn=_noop_register_media_bytes,
        apply_aspect_ratio_processing_fn=_noop_aspect_ratio_processing,
    )
    dispatch_processors = build_backend_dispatch_processors(
        prompt_id_factory=lambda: "prompt-1"
    )

    assert [processor.meta.name for processor in preprocessors] == [
        "inject_values",
        "load_rules",
        "validate_inputs",
        "resolve_derived_widgets",
        "validate_widgets",
        "apply_rules",
        "widget_overrides",
        "resolve_pipeline_controls",
        "pipeline_stages_before_upload",
        "upload_media",
        "pipeline_stages_after_upload",
    ]
    assert [processor.meta.name for processor in dispatch_processors] == [
        "submit_prompt",
    ]


def test_build_generation_processors_flattens_preprocess_and_dispatch_phases():
    processors = build_generation_processors(
        workflows_dir=Path("."),
        fallback_workflow_dirs=None,
        input_node_map={},
        analyze_mask_video_bounds_fn=lambda *_args, **_kwargs: (0, 0, 1, 1),
        crop_video_fn=lambda video_bytes, _crop: video_bytes,
        get_video_dimensions_fn=lambda _video_bytes: (1, 1),
        upload_video_bytes_fn=_noop_upload_video_bytes,
        register_media_bytes_fn=_noop_register_media_bytes,
        apply_aspect_ratio_processing_fn=_noop_aspect_ratio_processing,
        prompt_id_factory=lambda: "prompt-1",
    )

    assert [processor.meta.name for processor in processors] == [
        "inject_values",
        "load_rules",
        "validate_inputs",
        "resolve_derived_widgets",
        "validate_widgets",
        "apply_rules",
        "widget_overrides",
        "resolve_pipeline_controls",
        "pipeline_stages_before_upload",
        "upload_media",
        "pipeline_stages_after_upload",
        "submit_prompt",
    ]


def test_finalize_backend_response_enriches_json_response_with_pipeline_outputs():
    ctx = BackendPipelineContext(
        client=cast(Any, None),
        client_id="client-1",
        workflow={},
        warnings=[{"code": "warning_code", "message": "Warning message"}],
        applied_widget_values={"145:seed": "123"},
        pipeline_outputs={
            "aspect_ratio": {
                "aspect_ratio_processing": {"requested": {"aspect_ratio": "16:9"}}
            },
            "mask_processing": {
                "mask_crop_metadata": {"mode": "full"},
                "processed_mask_bytes": b"mask-bytes",
            },
        },
        comfyui_response=httpx.Response(
            200,
            json={"prompt_id": "prompt-1", "number": 1, "node_errors": {}},
        ),
    )

    result = finalize_backend_response(ctx)

    assert result.status_code == 200
    assert result.media_type == "application/json"

    payload = json.loads(result.content.decode("utf-8"))
    assert payload["prompt_id"] == "prompt-1"
    assert payload["workflow_warnings"] == [
        {"code": "warning_code", "message": "Warning message"}
    ]
    assert payload["applied_widget_values"] == {"145:seed": "123"}
    assert payload["pipeline_outputs"]["aspect_ratio"]["aspect_ratio_processing"] == {
        "requested": {"aspect_ratio": "16:9"}
    }
    assert payload["pipeline_outputs"]["mask_processing"]["mask_crop_metadata"] == {
        "mode": "full"
    }
    assert isinstance(
        payload["pipeline_outputs"]["mask_processing"]["processed_mask_video"],
        str,
    )


def test_iter_pipeline_stages_applies_registry_dependency_contract():
    ordered_stages = iter_pipeline_stages(
        {
            "pipeline": [
                {
                    "id": "mask_processing",
                    "kind": "mask_processing",
                    "targets": [],
                    "controls": [],
                },
                {
                    "id": "aspect_ratio",
                    "kind": "aspect_ratio",
                    "targets": [],
                    "controls": [],
                },
            ]
        }
    )

    assert [stage["kind"] for stage in ordered_stages] == [
        "aspect_ratio",
        "mask_processing",
    ]
