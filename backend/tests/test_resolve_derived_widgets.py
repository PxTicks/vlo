import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import pytest

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.resolve_derived_widgets import (
    resolve_derived_widgets_processor,
)
from services.workflow_rules import WorkflowValidationError


def _make_ctx(
    *,
    workflow: dict,
    rules: dict,
    derived_widget_values: dict[str, str],
) -> BackendPipelineContext:
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(),
        client_id="test-client",
        workflow=workflow,
        rules=rules,
        derived_widget_values=derived_widget_values,
    )
    return ctx


RETAKE_RULE = {
    "id": "retake_mode",
    "kind": "video_audio_retake",
    "label": "Retake",
    "default": "Video & Audio",
    "video_bypass": {"node_id": "705", "param": "switch"},
    "audio_bypass": {"node_id": "714", "param": "switch"},
}


def _retake_workflow() -> dict:
    return {
        "705": {"inputs": {"switch": False}},
        "714": {"inputs": {"switch": False}},
    }


@pytest.mark.parametrize(
    ("mode", "video_bypass", "audio_bypass"),
    [
        ("Video & Audio", False, False),
        ("Video", False, True),
        ("Audio", True, False),
    ],
)
def test_video_audio_retake_maps_enum_to_boolean_bypasses(
    mode: str,
    video_bypass: bool,
    audio_bypass: bool,
):
    ctx = _make_ctx(
        workflow=_retake_workflow(),
        rules={"derived_widgets": [RETAKE_RULE]},
        derived_widget_values={"retake_mode": mode},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["705"]["switch"] is video_bypass
    assert ctx.widget_overrides["714"]["switch"] is audio_bypass
    assert (
        ctx.applied_widget_values["derived:retake_mode:__value"] == mode
    )


def test_video_audio_retake_rejects_unknown_option():
    ctx = _make_ctx(
        workflow=_retake_workflow(),
        rules={"derived_widgets": [RETAKE_RULE]},
        derived_widget_values={"retake_mode": "Neither"},
    )

    with pytest.raises(WorkflowValidationError):
        asyncio.run(resolve_derived_widgets_processor.execute(ctx))
