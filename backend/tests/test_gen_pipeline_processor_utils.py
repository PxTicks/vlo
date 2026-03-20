import os
import sys

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.gen_pipeline.processors.utils.coerce import (  # noqa: E402
    coerce_bool,
    coerce_float,
    coerce_int,
    coerce_number,
    match_enum_value,
)
from services.gen_pipeline.processors.utils.warning import pipeline_warning  # noqa: E402
from services.gen_pipeline.processors.utils.widget_rule_lookup import (  # noqa: E402
    WidgetRuleLookup,
)


class TestCoerceInt:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (7, 7),
            (7.0, 7),
            (" 7 ", 7),
            ("-12", -12),
        ],
    )
    def test_accepts_integer_values(self, value, expected):
        assert coerce_int(value) == expected

    @pytest.mark.parametrize(
        "value",
        [True, False, 7.5, "7.5", "", "abc"],
    )
    def test_rejects_non_integer_values(self, value):
        assert coerce_int(value) is None


class TestCoerceFloat:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (7, 7.0),
            (7.5, 7.5),
            (" 7.25 ", 7.25),
            ("1e3", 1000.0),
        ],
    )
    def test_accepts_numeric_values(self, value, expected):
        assert coerce_float(value) == expected

    @pytest.mark.parametrize(
        "value",
        [True, False, "", "abc"],
    )
    def test_rejects_non_numeric_values(self, value):
        assert coerce_float(value) is None


class TestCoerceNumber:
    def test_preserves_int_type_for_integer_strings(self):
        result = coerce_number("42")

        assert result == 42
        assert isinstance(result, int)

    def test_returns_float_for_decimal_and_exponent_strings(self):
        decimal_result = coerce_number("42.5")
        exponent_result = coerce_number("1e3")

        assert decimal_result == 42.5
        assert isinstance(decimal_result, float)
        assert exponent_result == 1000.0
        assert isinstance(exponent_result, float)

    @pytest.mark.parametrize("value", [True, False, "", "abc"])
    def test_rejects_invalid_values(self, value):
        assert coerce_number(value) is None


class TestCoerceBool:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (True, True),
            (False, False),
            ("true", True),
            (" FALSE ", False),
        ],
    )
    def test_accepts_boolean_values(self, value, expected):
        assert coerce_bool(value) is expected

    @pytest.mark.parametrize("value", [1, 0, "yes", "", None])
    def test_rejects_non_boolean_values(self, value):
        assert coerce_bool(value) is None


class TestMatchEnumValue:
    def test_prefers_exact_match_before_string_fallback(self):
        options = [1, "1", "two"]

        assert match_enum_value(1, options) == 1
        assert match_enum_value("1", options) == "1"

    def test_uses_string_fallback_when_needed(self):
        assert match_enum_value(2, ["1", "2", "3"]) == "2"

    @pytest.mark.parametrize("options", [None, [], "bad"])
    def test_returns_none_for_invalid_options(self, options):
        assert match_enum_value("x", options) is None


class TestPipelineWarning:
    def test_omits_optional_fields_when_not_provided(self):
        assert pipeline_warning("warning_code", "Warning message") == {
            "code": "warning_code",
            "message": "Warning message",
        }

    def test_includes_optional_fields_when_provided(self):
        assert pipeline_warning(
            "warning_code",
            "Warning message",
            node_id="145",
            details={"param": "seed"},
        ) == {
            "code": "warning_code",
            "message": "Warning message",
            "node_id": "145",
            "details": {"param": "seed"},
        }


class TestWidgetRuleLookup:
    def test_returns_nested_rules_when_present(self):
        rules = {
            "nodes": {
                "145": {
                    "widgets": {
                        "seed": {
                            "value_type": "int",
                            "min": 0,
                            "max": 10,
                        }
                    }
                }
            }
        }

        lookup = WidgetRuleLookup(rules)

        assert lookup.get_node_rule("145") == rules["nodes"]["145"]
        assert lookup.get_widget_defs("145") == rules["nodes"]["145"]["widgets"]
        assert lookup.get_widget_rule("145", "seed") == {
            "value_type": "int",
            "min": 0,
            "max": 10,
        }

    def test_returns_none_for_missing_or_invalid_nested_shapes(self):
        lookup = WidgetRuleLookup(
            {
                "nodes": {
                    "145": {"widgets": []},
                    "146": {"widgets": {"seed": "not-a-dict"}},
                    "147": "not-a-dict",
                }
            }
        )

        assert lookup.get_widget_defs("145") is None
        assert lookup.get_widget_rule("146", "seed") is None
        assert lookup.get_node_rule("147") is None
        assert lookup.get_widget_rule("999", "seed") is None

    def test_handles_non_dict_nodes_root(self):
        lookup = WidgetRuleLookup({"nodes": []})

        assert lookup.get_node_rule("145") is None
        assert lookup.get_widget_defs("145") is None
        assert lookup.get_widget_rule("145", "seed") is None
