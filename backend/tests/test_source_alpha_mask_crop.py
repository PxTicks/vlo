"""Stills whose alpha is their mask: schema, pair collection and the crop step."""

import asyncio
from io import BytesIO

import httpx
import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.processors.mask_crop import create_mask_crop_processor
from services.gen_pipeline.processors.utils.mask_crop import compute_mask_crop
from services.workflow_rules import (
    collect_alpha_mask_crop_sources,
    collect_mask_crop_pairs,
    normalize_rules_model,
)
from services.workflow_rules.pipeline import resolve_pipeline_control_values
from services.workflow_rules.schema import WorkflowMaskProcessingStage, dump_resolved_rules
from services.workflow_rules.schema.models import MaskProcessingTarget

SOURCE = {"node_id": "1", "param": "image"}
MASK = {"node_id": "2", "param": "file"}

# A 1000x500 frame with a transparent 100x60 hole at (400, 200).
WIDTH, HEIGHT = 1000, 500
HOLE = (400, 200, 500, 260)


def _png(mode: str = "RGBA", hole: bool = True) -> bytes:
    pixels = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
    pixels[..., 0] = np.arange(WIDTH, dtype=np.uint32)[None, :] % 256
    pixels[..., 1] = 90
    pixels[..., 3] = 255
    if hole:
        x1, y1, x2, y2 = HOLE
        pixels[y1:y2, x1:x2, 3] = 0
    image = Image.fromarray(pixels, "RGBA").convert(mode)
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _decode(png: bytes) -> Image.Image:
    image = Image.open(BytesIO(png))
    image.load()
    return image


def _alpha_rules() -> dict:
    rules_model, warnings = normalize_rules_model(
        {
            "version": 3,
            "pipeline": [
                {
                    "id": "mask_processing",
                    "kind": "mask_processing",
                    "after": ["aspect_ratio"],
                    "targets": [{"source": SOURCE, "mask_source": "source_alpha"}],
                    "controls": [
                        {
                            "key": "crop_mode",
                            "value_type": "enum",
                            "expose": "widget",
                            "options": ["crop", "full"],
                            "default": "crop",
                        },
                        {
                            "key": "crop_dilation",
                            "value_type": "float",
                            "expose": "widget",
                            "default": 0.1,
                        },
                    ],
                },
                {
                    "id": "aspect_ratio",
                    "kind": "aspect_ratio",
                    "controls": [
                        {
                            "key": "target_resolution",
                            "value_type": "int",
                            "expose": "widget",
                            "default": 1024,
                        },
                        {
                            "key": "target_aspect_ratio",
                            "value_type": "string",
                            "expose": "widget",
                            "source": "client",
                        },
                    ],
                },
            ],
        }
    )
    assert warnings == []
    return dump_resolved_rules(rules_model)


def _run(image_bytes: bytes, crop_mode: str = "crop") -> BackendPipelineContext:
    rules = _alpha_rules()
    controls = resolve_pipeline_control_values(
        rules,
        workflow={},
        pipeline_inputs={
            "aspect_ratio": {"target_aspect_ratio": "2:1", "target_resolution": 1024},
            "mask_processing": {"crop_mode": crop_mode, "crop_dilation": 0.1},
        },
    )
    ctx = BackendPipelineContext(
        client=httpx.AsyncClient(base_url="http://example.test"),
        client_id="client",
        workflow={},
        rules=rules,
        buffered_media={
            "1:image": {
                "node_id": "1",
                "param": "image",
                "input_type": "image",
                "content_type": "image/png",
                "bytes": image_bytes,
            },
        },
        resolved_pipeline_controls=controls,
    )

    def unused(*_args, **_kwargs):
        raise AssertionError("a still never goes through the video crop helpers")

    asyncio.run(create_mask_crop_processor(unused, unused, unused).execute(ctx))
    return ctx


def test_mask_input_targets_still_need_a_mask():
    with pytest.raises(ValidationError, match="needs a mask"):
        MaskProcessingTarget.model_validate({"source": SOURCE})


def test_source_alpha_targets_take_no_mask():
    target = MaskProcessingTarget.model_validate({"source": SOURCE, "mask_source": "source_alpha"})
    assert target.mask is None

    with pytest.raises(ValidationError, match="drop mask"):
        MaskProcessingTarget.model_validate(
            {"source": SOURCE, "mask": MASK, "mask_source": "source_alpha"}
        )
    with pytest.raises(ValidationError, match="purpose 'video'"):
        MaskProcessingTarget.model_validate(
            {"source": SOURCE, "mask_source": "source_alpha", "purpose": "audio_timing"}
        )


def test_a_stage_cannot_mix_alpha_and_mask_input_targets():
    with pytest.raises(ValidationError, match="cannot mix"):
        WorkflowMaskProcessingStage.model_validate(
            {
                "id": "mask_processing",
                "targets": [
                    {"source": SOURCE, "mask_source": "source_alpha"},
                    {"source": {"node_id": "3", "param": "file"}, "mask": MASK},
                ],
            }
        )


def test_alpha_targets_are_crop_sources_not_mask_pairs():
    rules = _alpha_rules()

    assert collect_alpha_mask_crop_sources(rules) == ["1"]
    assert collect_mask_crop_pairs(rules) == []
    assert collect_alpha_mask_crop_sources(rules, mode_override="full") == []


def test_crop_mode_crops_the_still_like_a_mask_video_and_returns_its_mask():
    ctx = _run(_png())

    region = compute_mask_crop(HOLE, WIDTH, HEIGHT, 2.0, 0.1)
    assert region is not None
    x1, y1, x2, y2 = region
    outputs = ctx.pipeline_outputs["mask_processing"]
    assert outputs["mask_crop_metadata"]["mode"] == "cropped"
    assert outputs["mask_crop_metadata"]["crop_position"] == [x1, y1]
    assert outputs["mask_crop_metadata"]["crop_size"] == [x2 - x1, y2 - y1]
    assert outputs["mask_crop_metadata"]["container_size"] == [WIDTH, HEIGHT]

    # The uploaded still is the crop, alpha intact so the loader still sees the mask.
    cropped = _decode(ctx.buffered_media["1:image"]["bytes"])
    assert cropped.size == (x2 - x1, y2 - y1)
    assert cropped.mode == "RGBA"
    source = np.asarray(_decode(_png()))[y1:y2, x1:x2]
    assert np.array_equal(np.asarray(cropped), source)

    # The returned mask is that crop's 255 - alpha, as a PNG.
    assert outputs["processed_mask_content_type"] == "image/png"
    mask = np.asarray(_decode(outputs["processed_mask_bytes"]))
    assert np.array_equal(mask, 255 - source[..., 3])


def test_full_mode_uploads_the_whole_still_and_returns_its_full_mask():
    original = _png()
    ctx = _run(original, crop_mode="full")

    outputs = ctx.pipeline_outputs["mask_processing"]
    assert outputs["mask_crop_metadata"] == {"mode": "full"}
    assert ctx.buffered_media["1:image"]["bytes"] == original
    mask = np.asarray(_decode(outputs["processed_mask_bytes"]))
    assert mask.shape == (HEIGHT, WIDTH)
    assert mask[230, 450] == 255
    assert mask[0, 0] == 0


@pytest.mark.parametrize("mode", ["RGB", "RGBA"])
def test_an_unmasked_still_is_left_alone_and_returns_no_mask(mode):
    original = _png(mode=mode, hole=False)
    ctx = _run(original)

    outputs = ctx.pipeline_outputs["mask_processing"]
    assert ctx.buffered_media["1:image"]["bytes"] == original
    assert outputs["mask_crop_metadata"] == {"mode": "full"}
    if mode == "RGB":
        # No alpha at all: nothing is masked, so there is no patch mask.
        assert "processed_mask_bytes" not in outputs
    else:
        mask = np.asarray(_decode(outputs["processed_mask_bytes"]))
        assert not mask.any()
