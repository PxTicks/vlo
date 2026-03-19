import json
import os
import sys
from pathlib import Path
from typing import Any, cast

import httpx

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.comfyui.comfyui_generate import run_backend_postprocess  # noqa: E402
from services.gen_pipeline.context import BackendPipelineContext  # noqa: E402
from services.gen_pipeline.processors import (  # noqa: E402
    build_backend_dispatch_processors,
    build_backend_preprocessors,
    build_generation_processors,
)


async def _noop_upload_video_bytes(
    _client: Any,
    _video_bytes: bytes,
    _filename_value: str,
    _content_type: str,
) -> tuple[str | None, dict[str, Any] | None]:
    return None, None


def _noop_aspect_ratio_processing(
    _workflow: dict[str, Any],
    _rules: dict[str, Any],
    _target_aspect_ratio: str | None,
    _target_resolution: Any,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    return None, []


def _build_preprocessors():
    return build_backend_preprocessors(
        workflows_dir=Path("."),
        fallback_workflow_dirs=None,
        input_node_map={},
        analyze_mask_video_bounds_fn=lambda *_args, **_kwargs: (0, 0, 1, 1),
        crop_video_fn=lambda video_bytes, _crop: video_bytes,
        get_video_dimensions_fn=lambda _video_bytes: (1, 1),
        upload_video_bytes_fn=_noop_upload_video_bytes,
        apply_aspect_ratio_processing_fn=_noop_aspect_ratio_processing,
    )


def test_backend_generation_phase_builders_keep_dispatch_separate():
    preprocessors = _build_preprocessors()
    dispatch_processors = build_backend_dispatch_processors(
        prompt_id_factory=lambda: "prompt-1"
    )

    assert [processor.meta.name for processor in preprocessors] == [
        "inject_values",
        "load_rules",
        "validate_inputs",
        "validate_widgets",
        "apply_rules",
        "widget_overrides",
        "mask_crop",
        "upload_media",
        "aspect_ratio",
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
        apply_aspect_ratio_processing_fn=_noop_aspect_ratio_processing,
        prompt_id_factory=lambda: "prompt-1",
    )

    assert [processor.meta.name for processor in processors] == [
        "inject_values",
        "load_rules",
        "validate_inputs",
        "validate_widgets",
        "apply_rules",
        "widget_overrides",
        "mask_crop",
        "upload_media",
        "aspect_ratio",
        "submit_prompt",
    ]


def test_run_backend_postprocess_enriches_json_response_with_metadata():
    ctx = BackendPipelineContext(
        client=cast(Any, None),
        client_id="client-1",
        workflow={},
        warnings=[{"code": "warning_code", "message": "Warning message"}],
        applied_widget_values={"145:seed": "123"},
        aspect_ratio_metadata={"requested": {"aspect_ratio": "16:9"}},
        mask_crop_metadata={"mode": "full"},
        processed_mask_bytes=b"mask-bytes",
        comfyui_response=httpx.Response(200, json={"prompt_id": "prompt-1"}),
    )

    result = run_backend_postprocess(ctx)

    assert result.status_code == 200
    assert result.media_type == "application/json"

    payload = json.loads(result.content.decode("utf-8"))
    assert payload["prompt_id"] == "prompt-1"
    assert payload["workflow_warnings"] == [
        {"code": "warning_code", "message": "Warning message"}
    ]
    assert payload["applied_widget_values"] == {"145:seed": "123"}
    assert payload["aspect_ratio_processing"] == {
        "requested": {"aspect_ratio": "16:9"}
    }
    assert payload["mask_crop_metadata"] == {"mode": "full"}
    assert isinstance(payload["processed_mask_video"], str)
