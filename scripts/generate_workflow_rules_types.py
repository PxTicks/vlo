from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from services.workflow_rules.schema import ResolvedWorkflowRules  # noqa: E402


SCHEMA_OUTPUT_PATH = (
    BACKEND_ROOT
    / "services"
    / "workflow_rules"
    / "schema"
    / "resolved_workflow_rules.schema.json"
)
TS_OUTPUT_PATH = (
    REPO_ROOT
    / "frontend"
    / "src"
    / "features"
    / "generation"
    / "services"
    / "workflowRules"
    / "generated.ts"
)

TYPE_NAME_OVERRIDES = {
    "ResolvedWorkflowRules": "WorkflowRules",
    "ResolvedWorkflowRuleNode": "WorkflowRuleNode",
}
INDENT = "  "


def _ts_name(name: str) -> str:
    return TYPE_NAME_OVERRIDES.get(name, name)


def _ref_name(ref: str) -> str:
    return _ts_name(ref.rsplit("/", 1)[-1])


def _ts_literal(value: Any) -> str:
    return json.dumps(value)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def _render_union(variants: list[dict[str, Any]], level: int) -> str:
    return " | ".join(
        _dedupe([_render_type(variant, level) for variant in variants])
    )


def _render_object_members(schema: dict[str, Any], level: int) -> list[str]:
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    lines: list[str] = []

    if isinstance(properties, dict):
        for prop_name, prop_schema in properties.items():
            if not isinstance(prop_schema, dict):
                continue
            optional = prop_name not in required
            type_repr = _render_type(prop_schema, level + 1)
            lines.append(
                f"{INDENT * level}{prop_name}{'?' if optional else ''}: {type_repr};"
            )

    additional_properties = schema.get("additionalProperties")
    if isinstance(additional_properties, dict) and not properties:
        value_type = _render_type(additional_properties, level + 1)
        lines.append(f"{INDENT * level}[key: string]: {value_type};")

    return lines


def _render_inline_object(schema: dict[str, Any], level: int) -> str:
    members = _render_object_members(schema, level + 1)
    if not members:
        additional_properties = schema.get("additionalProperties")
        if isinstance(additional_properties, dict):
            value_type = _render_type(additional_properties, level + 1)
            return f"Record<string, {value_type}>"
        return "Record<string, unknown>"

    return "{\n" + "\n".join(members) + f"\n{INDENT * level}" + "}"


def _render_type(schema: dict[str, Any], level: int = 0) -> str:
    ref = schema.get("$ref")
    if isinstance(ref, str):
        return _ref_name(ref)

    if "const" in schema:
        return _ts_literal(schema["const"])

    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return " | ".join(_ts_literal(value) for value in enum)

    one_of = schema.get("oneOf")
    if isinstance(one_of, list) and one_of:
        return _render_union(one_of, level)

    any_of = schema.get("anyOf")
    if isinstance(any_of, list) and any_of:
        return _render_union(any_of, level)

    schema_type = schema.get("type")
    if isinstance(schema_type, list) and schema_type:
        return _render_union([{"type": item} for item in schema_type], level)

    if schema_type == "array":
        items = schema.get("items")
        if isinstance(items, dict):
            return f"Array<{_render_type(items, level)}>"
        return "unknown[]"

    if schema_type == "object":
        properties = schema.get("properties")
        additional_properties = schema.get("additionalProperties")
        if isinstance(properties, dict) and properties:
            return _render_inline_object(schema, level)
        if isinstance(additional_properties, dict):
            value_type = _render_type(additional_properties, level)
            return f"Record<string, {value_type}>"
        return "Record<string, unknown>"

    if schema_type in {"integer", "number"}:
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "string":
        return "string"
    if schema_type == "null":
        return "null"

    return "unknown"


def _render_definition(name: str, schema: dict[str, Any]) -> str:
    ts_name = _ts_name(name)
    schema_type = schema.get("type")

    if schema_type == "object" and isinstance(schema.get("properties"), dict):
        members = _render_object_members(schema, 1)
        body = "\n".join(members) if members else f"{INDENT}[key: string]: unknown;"
        return f"export interface {ts_name} {{\n{body}\n}}"

    return f"export type {ts_name} = {_render_type(schema)};"


def _render_typescript(schema: dict[str, Any]) -> str:
    defs = schema.get("$defs", {})
    if not isinstance(defs, dict):
        defs = {}

    blocks = [
        "/* eslint-disable */",
        "// This file is generated by scripts/generate_workflow_rules_types.py.",
        "// Do not edit it manually.",
    ]

    for name in sorted(defs):
        definition = defs[name]
        if not isinstance(definition, dict):
            continue
        blocks.append(_render_definition(name, definition))

    root_name = schema.get("title")
    if isinstance(root_name, str):
        blocks.append(_render_definition(root_name, schema))

    return "\n\n".join(blocks) + "\n"


def main() -> None:
    SCHEMA_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    TS_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    schema = ResolvedWorkflowRules.model_json_schema()
    SCHEMA_OUTPUT_PATH.write_text(
        json.dumps(schema, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    TS_OUTPUT_PATH.write_text(_render_typescript(schema), encoding="utf-8")


if __name__ == "__main__":
    main()
