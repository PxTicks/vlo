# Generation Pipeline

This document describes the generation pipeline at a high level, with a focus
on workflow sidecars (`*.rules.json`) and their default behavior.

## End-to-End Flow

1. Frontend preprocessors collect slot inputs into a `GenerationRequest`.
2. Backend `/comfy/generate` builds `GenerationInput` and runs backend processors.
3. ComfyUI runs the submitted prompt.
4. Frontend postprocessors fetch outputs, optionally stitch/resize, and import assets.

Backend processor order is defined in
`backend/services/pipeline/processors/__init__.py`:

1. `inject_values`
2. `apply_rules`
3. `widget_overrides`
4. `mask_crop`
5. `upload_media`
6. `aspect_ratio`
7. `submit_prompt`

## Workflow Sidecars

### Location and Naming

- Workflow file: `backend/assets/workflows/<workflow>.json`
- Sidecar file: `backend/assets/workflows/<workflow>.rules.json`
- Resolution logic: `sidecar_path_for_workflow()` in
  `backend/services/workflow_rules/normalize.py`

Sidecars are loaded for:

- `GET /comfy/workflow/rules/{filename}` to drive frontend presentation.
- `POST /comfy/generate` to apply runtime graph rewrites and preprocessing rules.

### If Sidecar Is Missing or Invalid

The system does not fail generation. It falls back to normalized defaults and
emits warnings.

- Missing sidecar: defaults, no warnings.
- Malformed JSON or read failure: defaults plus warning entries.
- Invalid rule fields: field-level fallback plus warning entries.

Warnings are returned from `/workflow/rules` and may also be included as
`workflow_warnings` in generation JSON responses.

### Supported Top-Level Sidecar Sections

- `nodes`
- `output_injections`
- `slots`
- `mask_cropping`
- `postprocessing`
- `aspect_ratio_processing`

### Node and Widget Exposure

`nodes` controls two separate things:

- Node input exposure (`present`) for workflow inputs.
- Widget exposure (`widgets`) for widget controls in the Generate panel.

Widget metadata (label/min/max/default/type/options) is resolved from
`object_info.json` whenever possible.

- If object_info has the node class: it is the source of truth.
- If object_info is missing that node: existing sidecar widget fields are used.

Per-node widget exposure modes:

- Default (no `widgets_mode`): expose `control_after_generate` widgets only.
- Special case: `KSampler` and `KSamplerAdvanced` default to exposing all
  editable widget params, even without `widgets_mode: "all"`.
- `widgets_mode: "all"`: expose all editable widget params for that node.
- `widgets`: explicit per-widget list for partial exposure.

### Smart Aspect Ratio Processing (Explicit Targets)

`aspect_ratio_processing` is "smart" in how it derives dimensions, but target
assignment is explicit and sidecar-driven.

- Enable with `aspect_ratio_processing.enabled: true`.
- Request provides `target_aspect_ratio` and `target_resolution` (long edge).
- Backend computes true dimensions, then picks the best stride-aligned pair
  using `stride` and `search_steps`.
- Injection only happens for nodes listed in
  `aspect_ratio_processing.target_nodes`.
- Each target node entry must declare `node_id`, `width_param`, and
  `height_param`.
- There is no auto-discovery of resize nodes and no per-node `exclude` flag.
  To exclude a node, do not include it in `target_nodes`.

`postprocess` under `aspect_ratio_processing` is separate: it controls frontend
resize behavior after generation, not backend node selection.

Example:

```json
{
  "aspect_ratio_processing": {
    "enabled": true,
    "stride": 16,
    "search_steps": 2,
    "target_nodes": [
      {
        "node_id": "214",
        "width_param": "width",
        "height_param": "height"
      },
      {
        "node_id": "315",
        "width_param": "image_width",
        "height_param": "image_height"
      }
    ],
    "postprocess": {
      "enabled": true,
      "mode": "stretch_exact",
      "apply_to": "all_visual_outputs"
    }
  }
}
```

### Default Behavior (No Sidecar or Empty Sidecar)

| Section | Default |
| --- | --- |
| `version` | `1` |
| `nodes` | `{}` (no ignored/present/widget overrides) |
| `output_injections` | `{}` (no graph rewrites) |
| `slots` | `{}` (no manual slot declarations) |
| `mask_cropping` | `{ "mode": "crop" }` |
| `postprocessing` | `{ "mode": "auto", "panel_preview": "raw_outputs", "on_failure": "fallback_raw" }` |
| `aspect_ratio_processing` | `enabled: false`, `stride: 16`, `search_steps: 2`, `target_nodes: []`, postprocess enabled with `stretch_exact` + `all_visual_outputs` |

## Sidecar Effects in Runtime

- `output_injections` can reroute downstream links to another node output or a
  manual slot payload.
- `nodes.*.ignore` can remove nodes when safe after rewrites.
- `nodes.*.widgets` and widget modes influence backend widget value
  randomization/fixed behavior.
- `mask_cropping.mode = "full"` disables derived-mask crop preprocessing.
- `postprocessing` config controls frontend import/preview behavior.
- `aspect_ratio_processing` can modify target nodes and return metadata used by
  frontend resize postprocessing.

## Widget Rule Enrichment

After loading/normalizing sidecar rules, widget definitions are resolved using
`backend/assets/.config/object_info.json`.

- For default mode, object_info auto-discovers `control_after_generate` widgets.
- For `widgets_mode: "all"`, object_info provides the full widget list.
- For explicit `widgets`, object_info still augments missing datatype metadata
  (for example `value_type` / `options`) when available.

## Sidecar Examples

### Partial Widget Exposure (Explicit List)

```json
{
  "version": 1,
  "nodes": {
    "145": {
      "node_title": "KSampler",
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true
        },
        "cfg": {
          "label": "CFG",
          "control_after_generate": true,
          "min": 1,
          "max": 30
        }
      }
    }
  }
}
```

### Whole-Node Widget Exposure (All Widgets)

```json
{
  "version": 1,
  "nodes": {
    "145": {
      "widgets_mode": "all"
    }
  }
}
```

The frontend will render these widgets under a section titled with the node
title (`node_title` or workflow node title from object_info/workflow metadata).

## Minimal Sidecar Example

```json
{
  "version": 1,
  "mask_cropping": { "mode": "crop" },
  "postprocessing": {
    "mode": "auto",
    "panel_preview": "raw_outputs",
    "on_failure": "fallback_raw"
  },
  "nodes": {
    "145": {
      "present": {
        "enabled": true,
        "input_type": "video",
        "param": "video",
        "label": "Source Video"
      }
    }
  }
}
```
