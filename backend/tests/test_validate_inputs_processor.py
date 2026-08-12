from services.gen_pipeline.processors.validate_inputs import (
    collect_provided_input_ids_from_sources,
    is_provided_value,
)


def test_wrapped_empty_batch_is_not_provided():
    injections = {"141": {"images": {"__value__": []}}}

    assert is_provided_value({"__value__": []}) is False
    assert collect_provided_input_ids_from_sources(injections, None) == set()


def test_wrapped_batch_requires_at_least_one_non_empty_value():
    assert is_provided_value({"__value__": [""]}) is False
    assert is_provided_value({"__value__": ["media-id-123"]}) is True

    assert collect_provided_input_ids_from_sources(
        {"141": {"images": {"__value__": ["media-id-123"]}}},
        None,
    ) == {"141", "141:images"}
