"""V3 (io.Combo) dropdowns serialize as ``("COMBO", {"options": [...]})``.

Legacy nodes put the option list in the type slot instead; both shapes must
surface as enum widgets, and both must occupy a ``widgets_values`` slot.
"""

from typing import Any

import pytest

from services.workflow_rules.node_parsing import (
    build_widget_entries_for_class,
    get_widget_value_index_map,
    resolve_widget_param_metadata,
)
from services.workflow_rules.object_info import (
    enrich_rules_with_object_info,
    set_object_info_cache,
)

_SAMPLERS = ["euler", "res_multistep", "uni_pc"]
_SCHEDULERS = ["normal", "simple", "beta"]


def _object_info() -> dict[str, Any]:
    return {
        "KSamplerSelect": {
            "input": {
                "required": {
                    "sampler_name": ["COMBO", {"multiselect": False, "options": _SAMPLERS}],
                }
            },
            "input_order": {"required": ["sampler_name"]},
        },
        "BasicScheduler": {
            "input": {
                "required": {
                    "model": ["MODEL", {}],
                    "scheduler": ["COMBO", {"multiselect": False, "options": _SCHEDULERS}],
                    "steps": ["INT", {"default": 20, "min": 1, "max": 10000}],
                    "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}],
                }
            },
            "input_order": {"required": ["model", "scheduler", "steps", "denoise"]},
        },
    }


@pytest.fixture(autouse=True)
def object_info_cache_guard():
    set_object_info_cache({})
    yield
    set_object_info_cache(None)


def test_v3_combo_resolves_as_enum_with_options():
    metadata = resolve_widget_param_metadata(
        "KSamplerSelect",
        _object_info(),
        {"sampler_name"},
        widgets_values=["res_multistep"],
    )

    assert metadata["sampler_name"] == {
        "value_type": "enum",
        "options": _SAMPLERS,
        "default": "res_multistep",
    }


def test_v3_combo_occupies_a_widget_values_slot():
    # Skipping the combo would shift steps/denoise onto the wrong slots.
    assert get_widget_value_index_map("BasicScheduler", _object_info()) == {
        "scheduler": 0,
        "steps": 1,
        "denoise": 2,
    }

    widgets = build_widget_entries_for_class(
        "BasicScheduler",
        _object_info(),
        widgets_values=["simple", 12, 0.5],
        include_all_widgets=True,
    )
    assert widgets is not None
    assert widgets["scheduler"]["options"] == _SCHEDULERS
    assert widgets["scheduler"]["default"] == "simple"
    assert widgets["steps"]["default"] == 12
    assert widgets["denoise"]["default"] == 0.5


def test_combo_without_options_is_not_a_widget():
    object_info = {
        "Node": {
            "input": {"required": {"choice": ["COMBO", {}]}},
            "input_order": {"required": ["choice"]},
        }
    }

    assert resolve_widget_param_metadata("Node", object_info, {"choice"}) == {}


def test_enrichment_turns_sidecar_v3_combo_widgets_into_dropdowns():
    set_object_info_cache(_object_info())
    workflow = {
        "nodes": [
            {
                "id": 36,
                "type": "KSamplerSelect",
                "inputs": [],
                "widgets_values": ["res_multistep"],
            },
            {
                "id": 37,
                "type": "BasicScheduler",
                "inputs": [{"name": "model", "type": "MODEL", "link": 1}],
                "widgets_values": ["simple", 20, 1],
            },
        ],
        "links": [],
    }
    rules: dict[str, Any] = {
        "version": 3,
        "nodes": {
            "36": {"widgets": {"sampler_name": {"label": "Sampler"}}},
            "37": {"widgets": {"scheduler": {"label": "Scheduler"}}},
        },
    }

    enriched = enrich_rules_with_object_info(rules, workflow)

    sampler = enriched["nodes"]["36"]["widgets"]["sampler_name"]
    assert sampler["value_type"] == "enum"
    assert sampler["options"] == _SAMPLERS
    assert sampler["default"] == "res_multistep"
    scheduler = enriched["nodes"]["37"]["widgets"]["scheduler"]
    assert scheduler["value_type"] == "enum"
    assert scheduler["options"] == _SCHEDULERS
    assert scheduler["default"] == "simple"
