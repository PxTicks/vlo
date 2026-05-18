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


SINGLE_SAMPLER_DENOISE_RULE = {
    "id": "single_sampler_denoise",
    "kind": "single_sampler_denoise",
    "label": "Denoise",
    "total_steps": {"node_id": "115", "param": "steps"},
    "start_step": {"node_id": "115", "param": "start_at_step"},
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


def test_single_sampler_denoise_maps_fraction_to_start_step():
    ctx = _make_ctx(
        workflow={"115": {"inputs": {"steps": 6, "start_at_step": 0}}},
        rules={"derived_widgets": [SINGLE_SAMPLER_DENOISE_RULE]},
        derived_widget_values={"single_sampler_denoise": "0.5"},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["115"]["start_at_step"] == 3
    assert (
        ctx.applied_widget_values["derived:single_sampler_denoise:__value"]
        == "0.5"
    )


def test_single_sampler_denoise_allows_full_denoise():
    ctx = _make_ctx(
        workflow={"115": {"inputs": {"steps": 6, "start_at_step": 3}}},
        rules={"derived_widgets": [SINGLE_SAMPLER_DENOISE_RULE]},
        derived_widget_values={"single_sampler_denoise": "1"},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["115"]["start_at_step"] == 0
    assert (
        ctx.applied_widget_values["derived:single_sampler_denoise:__value"]
        == "1.0"
    )


DUAL_SAMPLER_DENOISE_RULE = {
    "id": "dual_sampler_denoise",
    "kind": "dual_sampler_denoise",
    "label": "Denoise",
    "total_steps": {"node_id": "85", "param": "value"},
    "start_step": {"node_id": "57", "param": "start_at_step"},
    "base_split_step": {"node_id": "86", "param": "value"},
    "split_step_targets": [
        {"node_id": "57", "param": "end_at_step"},
        {"node_id": "58", "param": "start_at_step"},
    ],
    "second_sampler_add_noise": {"node_id": "58", "param": "add_noise"},
}


def _dual_sampler_workflow() -> dict:
    return {
        "57": {"inputs": {"start_at_step": 0, "end_at_step": 4, "add_noise": "enable"}},
        "58": {"inputs": {"start_at_step": 4, "add_noise": "disable"}},
        "85": {"inputs": {"value": 8}},
        "86": {"inputs": {"value": 4}},
    }


def test_dual_sampler_denoise_keeps_second_sampler_silent_when_first_runs():
    # denoise=1.0 → start_step=0, split_step=base_split=4 → first sampler runs 4 steps.
    ctx = _make_ctx(
        workflow=_dual_sampler_workflow(),
        rules={"derived_widgets": [DUAL_SAMPLER_DENOISE_RULE]},
        derived_widget_values={"dual_sampler_denoise": "1.0"},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["57"]["start_at_step"] == 0
    assert ctx.widget_overrides["57"]["end_at_step"] == 4
    assert ctx.widget_overrides["58"]["start_at_step"] == 4
    assert ctx.widget_overrides["58"]["add_noise"] == "disable"


def test_dual_sampler_denoise_enables_second_sampler_noise_when_first_skipped():
    # denoise=0.25 → denoise_steps=2, start_step=6 > base_split=4 →
    # split_step=6, first sampler runs zero steps and must be replaced.
    ctx = _make_ctx(
        workflow=_dual_sampler_workflow(),
        rules={"derived_widgets": [DUAL_SAMPLER_DENOISE_RULE]},
        derived_widget_values={"dual_sampler_denoise": "0.25"},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["57"]["start_at_step"] == 6
    assert ctx.widget_overrides["57"]["end_at_step"] == 6
    assert ctx.widget_overrides["58"]["start_at_step"] == 6
    assert ctx.widget_overrides["58"]["add_noise"] == "enable"


def test_dual_sampler_denoise_enables_second_sampler_at_split_boundary():
    # denoise=0.5 → start_step=4 == base_split=4 → first sampler still runs
    # zero steps (start_at_step == end_at_step), so the second sampler must
    # take over noise introduction.
    ctx = _make_ctx(
        workflow=_dual_sampler_workflow(),
        rules={"derived_widgets": [DUAL_SAMPLER_DENOISE_RULE]},
        derived_widget_values={"dual_sampler_denoise": "0.5"},
    )

    asyncio.run(resolve_derived_widgets_processor.execute(ctx))

    assert ctx.widget_overrides["57"]["start_at_step"] == 4
    assert ctx.widget_overrides["57"]["end_at_step"] == 4
    assert ctx.widget_overrides["58"]["add_noise"] == "enable"


def test_video_audio_retake_rejects_unknown_option():
    ctx = _make_ctx(
        workflow=_retake_workflow(),
        rules={"derived_widgets": [RETAKE_RULE]},
        derived_widget_values={"retake_mode": "Neither"},
    )

    with pytest.raises(WorkflowValidationError):
        asyncio.run(resolve_derived_widgets_processor.execute(ctx))
