import base64
import json
import os
import sys
from pathlib import Path

import httpx

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.comfyui.comfyui_generate import finalize_backend_response
from services.gen_pipeline.context import BackendPipelineContext
from services.workflow_rules import load_rules_model_for_workflow
from services.workflow_rules.mask_pairs import collect_mask_crop_pairs
from services.workflow_rules.pipeline import resolve_pipeline_control_values
from services.workflow_rules.schema import dump_resolved_rules, get_pipeline_stage


DEFAULT_WORKFLOWS_DIR = (
    Path(__file__).resolve().parent.parent
    / "assets"
    / ".config"
    / "default_workflows"
)


def test_vace_inpaint_new_uses_v3_pipeline_stage_controls():
    rules, warnings = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint_new.json",
    )

    assert warnings == []
    assert rules.version == 3

    mask_stage = get_pipeline_stage(rules, "mask_processing")
    assert mask_stage is not None
    treatment_control = next(
        control
        for control in mask_stage.controls
        if control.key == "source_video_treatment"
    )
    assert treatment_control.expose == "hidden"
    assert treatment_control.exclude_options == ["preserve_transparency"]

    aspect_stage = get_pipeline_stage(rules, "aspect_ratio")
    assert aspect_stage is not None
    assert [target.width.node_id for target in aspect_stage.targets] == ["104", "105"]


def test_vace_inpaint_new_resolves_denoise_driven_source_video_treatment():
    rules_model, _ = load_rules_model_for_workflow(
        DEFAULT_WORKFLOWS_DIR,
        "vlo_VACE_inpaint_new.json",
    )
    rules = dump_resolved_rules(rules_model)

    resolved = resolve_pipeline_control_values(
        rules,
        workflow={"92": {"inputs": {"denoise": 0.6}}},
        pipeline_inputs={},
        control_option_fallbacks={
            ("mask_processing", "source_video_treatment"): [
                "preserve_transparency",
                "fill_transparent_with_neutral_gray",
                "remove_transparency",
            ]
        },
    )

    assert resolved["mask_processing"]["source_video_treatment"] == "remove_transparency"
    assert collect_mask_crop_pairs(rules) == [("98", "101")]


def test_finalize_backend_response_serializes_pipeline_outputs():
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(base_url="http://example.test"),
        client_id="client",
        workflow={"1": {"inputs": {}}},
        pipeline_outputs={
            "mask_processing": {
                "mask_crop_metadata": {"mode": "full"},
                "processed_mask_bytes": b"abc",
            }
        },
        comfyui_response=httpx.Response(
            200,
            json={
                "prompt_id": "prompt-1",
                "number": 1,
                "node_errors": {},
            },
        ),
    )

    result = finalize_backend_response(ctx)
    payload = json.loads(result.content)

    assert payload["pipeline_outputs"]["mask_processing"]["mask_crop_metadata"] == {
        "mode": "full"
    }
    assert payload["pipeline_outputs"]["mask_processing"]["processed_mask_video"] == (
        base64.b64encode(b"abc").decode("ascii")
    )
    assert "processed_mask_bytes" not in payload["pipeline_outputs"]["mask_processing"]
