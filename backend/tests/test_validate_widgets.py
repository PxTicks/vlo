import httpx
import pytest

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.validate_widgets import validate_widgets_processor
from services.workflow_rules import WorkflowValidationError


@pytest.mark.anyio
async def test_invalid_rule_override_for_missing_node_still_fails_validation():
    # A node missing from the prompt is no reason to skip validating a value
    # its rule rejects. A valid value for a missing node still passes, though:
    # nodes muted in the ComfyUI editor keep their rule widgets in the panel.
    async with httpx.AsyncClient() as client:
        ctx = BackendPipelineContext(
            client=client,
            client_id="test-client",
            workflow={"112": {"class_type": "BasicScheduler", "inputs": {"steps": 4}}},
            widget_overrides={"116": {"lora_name": "unavailable-lora.safetensors"}},
            rules={
                "nodes": {
                    "116": {
                        "widgets": {
                            "lora_name": {
                                "value_type": "enum",
                                "options": ["available-lora.safetensors"],
                            }
                        }
                    }
                }
            },
        )

        with pytest.raises(WorkflowValidationError) as exc:
            await validate_widgets_processor.execute(ctx)

    assert [(f["node_id"], f["param"]) for f in exc.value.failures] == [("116", "lora_name")]


@pytest.mark.anyio
@pytest.mark.parametrize("options", [[], ["available-lora.safetensors"]])
async def test_active_seam_lora_still_rejects_unavailable_model(options: list[str]):
    async with httpx.AsyncClient() as client:
        ctx = BackendPipelineContext(
            client=client,
            client_id="test-client",
            workflow={
                "116": {
                    "class_type": "vloMiniMaxH3LoraLoader",
                    "inputs": {"lora_name": "unavailable-lora.safetensors"},
                }
            },
            widget_overrides={"116": {"lora_name": "unavailable-lora.safetensors"}},
            rules={
                "nodes": {
                    "116": {"widgets": {"lora_name": {"value_type": "enum", "options": options}}}
                }
            },
        )

        with pytest.raises(WorkflowValidationError) as exc:
            await validate_widgets_processor.execute(ctx)

    assert exc.value.failures == [
        {
            "kind": "widget",
            "node_id": "116",
            "param": "lora_name",
            "message": "Value must match one of the allowed options.",
        }
    ]
