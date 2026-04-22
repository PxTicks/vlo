# Workflow Sidecar Authoring

A **sidecar** is a `*.rules.json` file that sits next to a ComfyUI workflow
JSON and controls how that workflow is presented in the Generate panel and
how the backend rewrites it before dispatch.

This document walks through authoring a sidecar, using the real
[`video_ltx2_3_retake.rules.json`](../../assets/.config/default_workflows/video_ltx2_3_retake.rules.json)
as the running example. It also covers the decisions an author will hit
most often: manual widget exposure, hiding things, mask processing, and
aspect ratio processing.

For the pipeline runtime that actually consumes these sidecars, see
[README.md](README.md).

---

## File Layout

Two directories hold workflows:

- `backend/assets/workflows/` — **primary**. User-authored workflows live
  here, and it is also where the `POST /comfy/workflow/save/{filename}`
  endpoint writes modified workflows. Sidecars sit next to each workflow as
  `<stem>.rules.json`.
- `backend/assets/.config/default_workflows/` — **packaged** workflows
  shipped with the app. Read-only from the author's perspective; treat as
  the fallback source when `WORKFLOWS_DIR` does not contain a requested
  file.

Resolution order for both the workflow JSON and its sidecar is:

1. `backend/assets/workflows/<name>.json` / `<name>.rules.json`
2. `backend/assets/.config/default_workflows/<name>.json` / `<name>.rules.json`

This is wired via `WORKFLOWS_DIR` + `fallback_workflow_dirs=[DEFAULT_WORKFLOWS_DIR]`
in [`../comfyui/comfyui_generate.py`](../comfyui/comfyui_generate.py) and
[`../../routers/comfyui.py`](../../routers/comfyui.py). Sidecar resolution
itself is implemented by `sidecar_path_for_workflow()` in
[`../workflow_rules/normalize.py`](../workflow_rules/normalize.py).

When editing a packaged workflow, saving produces a user copy in
`backend/assets/workflows/` that thereafter shadows the packaged version —
the original in `.config/default_workflows/` is never mutated.

Sidecars are loaded for:

- `GET /comfy/workflow/rules/{filename}` — drives frontend presentation.
- `POST /comfy/generate` — applies runtime rewrites and preprocessing rules.

If the sidecar is missing the system falls back to defaults with no
warnings. If it is present but malformed or schema-invalid, defaults are
used with per-field warnings attached to the response — generation is
never failed by sidecar problems alone.

---

## Root Structure (V3)

V3 is the current authored format and it is **strict**: legacy V1/V2 top-level
fields (`mask_processing`, `aspect_ratio_processing`, `postprocessing`) and
legacy node-level derived-mask fields (`binary_derived_mask_of`,
`soft_derived_mask_of`, etc.) are rejected rather than silently migrated.

```json
{
  "version": 3,
  "name": "Optional display name",
  "default_widgets_mode": "control_after_generate",
  "nodes": {},
  "validation": { "inputs": [] },
  "derived_widgets": [],
  "output_injections": {},
  "effect_switches": [],
  "slots": {},
  "media_fallbacks": [],
  "pipeline": []
}
```

| Field                  | Type                                  | Default                    |
| ---------------------- | ------------------------------------- | -------------------------- |
| `version`              | `3` (literal)                         | required                   |
| `name`                 | string                                | none                       |
| `default_widgets_mode` | `"control_after_generate"` \| `"all"` | unset (per-node policy)    |
| `nodes`                | object keyed by node id               | `{}`                       |
| `validation`           | object                                | `{ "inputs": [] }`         |
| `derived_widgets`      | array                                 | `[]`                       |
| `output_injections`    | nested object (see below)             | `{}`                       |
| `effect_switches`      | array of first-match effect cases     | `[]`                       |
| `slots`                | object keyed by slot id               | `{}`                       |
| `media_fallbacks`      | array                                 | `[]`                       |
| `pipeline`             | array of stages                       | `[]`                       |

---

## Running Example: LTX2.3 ReTake

The ReTake workflow does video-plus-audio retake with binary masks. Its
sidecar is a good small-but-complete example — it uses manual widget
exposure, hiding, a derived widget, and both pipeline stages.

```json
{
  "version": 3,
  "name": "LTX2.3 ReTake",

  "nodes": {
    "115": {
      "widgets": {
        "noise_seed": {
          "label": "Noise seed",
          "control_after_generate": true,
          "value_type": "int",
          "group_id": "video_generation",
          "group_title": "Video Generation",
          "group_order": 3
        }
      }
    },
    "497": {
      "widgets": {
        "value": {
          "label": "Max Pixel Size (Longest Side)",
          "value_type": "int",
          "group_id": "video_generation",
          "group_title": "Video Generation",
          "group_order": 0
        }
      }
    },
    "626": { "present": { "enabled": false } },
    "644": {
      "present": {
        "label": "Source video",
        "input_type": "video",
        "param": "video",
        "class_type": "VHS_LoadVideoFFmpeg"
      },
      "selection": { "export_fps": 24, "max_frames": 361 }
    },
    "689": {},
    "691": {},
    "705": {
      "widgets": {
        "switch": {
          "label": "Bypass video retake",
          "value_type": "boolean",
          "default": false,
          "hidden": true
        }
      }
    },
    "714": {
      "widgets": {
        "switch": {
          "label": "Bypass audio retake",
          "value_type": "boolean",
          "default": false,
          "hidden": true
        }
      }
    }
  },

  "derived_widgets": [
    {
      "id": "retake_mode",
      "kind": "video_audio_retake",
      "label": "Retake",
      "group_id": "retake",
      "group_title": "Retake",
      "group_order": 0,
      "default": "Video & Audio",
      "video_bypass": { "node_id": "705", "param": "switch" },
      "audio_bypass": { "node_id": "714", "param": "switch" }
    }
  ],

  "pipeline": [
    {
      "id": "mask_processing",
      "kind": "mask_processing",
      "after": ["aspect_ratio"],
      "targets": [
        {
          "source": { "node_id": "644", "param": "video" },
          "mask":   { "node_id": "689", "param": "file" },
          "mask_type": "binary",
          "purpose": "video"
        },
        {
          "source": { "node_id": "644", "param": "video" },
          "mask":   { "node_id": "691", "param": "file" },
          "mask_type": "binary",
          "purpose": "audio_timing",
          "render_fps": 25
        }
      ],
      "controls": [
        {
          "key": "crop_mode",
          "label": "Mask crop mode",
          "value_type": "enum",
          "expose": "widget",
          "options": ["crop", "full"],
          "default": "crop"
        },
        {
          "key": "crop_dilation",
          "label": "Mask crop padding",
          "value_type": "float",
          "expose": "widget",
          "control": "slider",
          "slider_display": "percent",
          "min": 0, "max": 0.5, "step": 0.01,
          "default": 0.1
        },
        {
          "key": "source_video_treatment",
          "label": "Transparency handling",
          "value_type": "enum",
          "expose": "widget",
          "default": "preserve_transparency"
        }
      ]
    },
    {
      "id": "aspect_ratio",
      "kind": "aspect_ratio",
      "config": {
        "stride": 32,
        "search_steps": 2,
        "resolutions": [480, 720, 1080],
        "postprocess": {
          "enabled": true,
          "mode": "stretch_exact",
          "apply_to": "all_visual_outputs"
        }
      },
      "targets": [
        { "width": { "node_id": "512", "param": "width" },
          "height":{ "node_id": "512", "param": "height" } },
        { "width": { "node_id": "693", "param": "resize_type.width" },
          "height":{ "node_id": "693", "param": "resize_type.height" } }
      ],
      "controls": [
        {
          "key": "target_resolution",
          "label": "Resolution",
          "value_type": "int",
          "expose": "widget",
          "options": [480, 720, 1080],
          "default": 1080
        },
        {
          "key": "target_aspect_ratio",
          "value_type": "string",
          "expose": "none",
          "source": "client"
        }
      ]
    }
  ]
}
```

Things to read off this example:

- **`644` is the only user-facing primary input.** It declares a video input
  with a specific param and a ComfyUI class type override. `selection`
  configures the frame picker.
- **`689` and `691` are masks**, not user inputs. They appear in `nodes`
  (present entries empty) so they are recognized, but because they are
  named as `mask` targets under `mask_processing.targets` they are hidden
  from the primary input list.
- **`626` is suppressed** from the input list via `present.enabled: false`
  while staying in the graph.
- **`705` and `714` are bypass switches** driven by the `retake_mode`
  derived widget. They are present-but-hidden so the derived widget owns
  their value.
- **Widget grouping** is cross-node: `noise_seed` on node `115` and
  `Max Pixel Size` on node `497` share `group_id: "video_generation"` and
  render under one collapsible section.

---

## Manual vs Automatic Widget Exposure

Widgets are auto-discovered from `object_info.json`. The question an
author is always really asking is: *which widgets should the user see, and
with what labels / ranges / grouping?*

There are three regimes:

### 1. Fully automatic (no sidecar, or empty `nodes`)

- Primary inputs are detected by parameter flags (`image_upload`,
  `video_upload`, `dynamicPrompts`).
- Widget discovery follows the node's **widgets mode**:
  - `"control_after_generate"` (default for most nodes): only widgets
    flagged `control_after_generate` in `object_info` are shown.
  - `"all"` (default for `KSampler` / `KSamplerAdvanced` by policy): every
    editable widget is shown.

Mode resolution, in priority order:

1. Per-node `widgets_mode` in the sidecar.
2. Node policy rules (KSampler family → `"all"`).
3. Root-level `default_widgets_mode`.
4. `"control_after_generate"`.

### 2. Selective — list specific widgets per node

Most authored sidecars do this. The `widgets` dict is an overlay on top of
auto-discovery: explicit values win, missing metadata (`value_type`,
`options`, `min`/`max`, `default`) is filled from `object_info`.

```json
{
  "nodes": {
    "145": {
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true,
          "min": 0,
          "max": 999999
        },
        "cfg": { "label": "CFG Scale", "min": 1, "max": 30 }
      }
    }
  }
}
```

### 3. Expose everything, then subtract

Set `widgets_mode: "all"` on the node, then use `hidden: true` on the
individual widgets you want to suppress. This is the right pattern when
you want "basically all controls, minus a few internal ones".

```json
{
  "nodes": {
    "145": {
      "widgets_mode": "all",
      "widgets": {
        "internal_param": { "hidden": true }
      }
    }
  }
}
```

### Per-widget fields worth knowing

| Field                    | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `label`                  | UI display label                                                  |
| `control_after_generate` | Expose for adjustment after generation                            |
| `default_randomize`      | Randomize by default (requires `min`/`max`)                       |
| `hidden`                 | Completely hidden from UI; value stays in the workflow            |
| `frontend_only`          | Rendered in UI, value not sent to backend                         |
| `group_id` / `group_title` / `group_order` | Cross-node grouping                              |
| `min` / `max` / `step`   | Bounds; used by validation and randomization                      |
| `default`                | Authored default; falls back to `object_info`                     |
| `value_type`             | `"int" \| "float" \| "string" \| "boolean" \| "enum" \| "unknown"` |
| `options`                | Allowed values for enums                                          |
| `control` / `slider_display` / `unit` | Presentation hints (e.g. `"slider"`)                 |
| `true_value` / `false_value` | Custom booleans (e.g. mapping to enum strings)                |
| `default_overrides`      | Conditional defaults driven by `ConditionExpression`              |

---

## Conditions

Conditional rules use a shared `ConditionExpression` tree. The same shape is
used by widget default overrides, node `ignore_overrides`, output injections,
rewrites, and `effect_switches`.

Leaf conditions:

- `always` — matches unless `value` is explicitly `false`.
- `input_presence` — checks submitted media/text inputs by id.
- `compare` — resolves a `StateReference` and compares it with `eq`, `neq`,
  `lt`, `lte`, `gt`, or `gte`.

Combinators:

- `all_of` — every nested condition must match.
- `any_of` — at least one nested condition must match.
- `not` — inverts one nested condition.

`StateReference` has four kinds:

| Kind               | Shape                                      | Resolves from                                  |
| ------------------ | ------------------------------------------ | ---------------------------------------------- |
| `workflow_param`   | `{ "node_id": "92", "param": "denoise" }`  | Current workflow node input/widget value       |
| `pipeline_control` | `{ "stage_id": "mask_processing", "key": "crop_mode" }` | Resolved pipeline controls         |
| `frontend_control` | `{ "control_id": "prompt_enhancer_enabled" }` | Frontend-only controls submitted by the panel |
| `derived_widget`   | `{ "derived_widget_id": "single_sampler_denoise" }` | Derived widget values from the panel     |

Example:

```json
{
  "kind": "all_of",
  "conditions": [
    { "kind": "input_presence", "inputs": ["98"], "match": "all_present" },
    {
      "kind": "compare",
      "ref": {
        "kind": "derived_widget",
        "derived_widget_id": "single_sampler_denoise"
      },
      "operator": "lt",
      "value": 1
    }
  ]
}
```

Legacy condition leaves `widget_boolean` and `frontend_control_boolean` are
still accepted and auto-migrated to `compare` during schema parsing. New rules
should author `compare` directly.

---

## Hiding Things

There are four distinct "hide" operations. Picking the wrong one is a
common source of bugs.

| You want to…                                                                      | Use                                    |
| --------------------------------------------------------------------------------- | -------------------------------------- |
| Remove a node from the graph entirely                                             | `nodes.<id>.ignore: true`              |
| Keep a node in the graph, but not show it as an input                             | `nodes.<id>.present.enabled: false`    |
| Keep a widget in the workflow, but not show it in the UI                          | `widgets.<param>.hidden: true`         |
| Show a widget in the UI but not submit its value to the backend                   | `widgets.<param>.frontend_only: true`  |

`ignore: true` is cascading: once a node is removed, parents whose only
consumers just disappeared are re-evaluated and may also be removed.
Conditional removal can be driven by `ConditionExpression` via
`ignore_overrides`.

### Optional vs required inputs

Input presence at generation time is controlled two ways:

- **Validation** (`validation.inputs`) declares the check. References are
  strings of the form `"node_id"` or `"node_id:param"`:

  ```json
  {
    "validation": {
      "inputs": [
        { "kind": "required", "input": "3", "message": "Prompt is required." },
        { "kind": "at_least_n", "inputs": ["68", "62"], "min": 1,
          "message": "Provide at least one frame input." },
        { "kind": "optional", "input": "99" }
      ]
    }
  }
  ```

  `optional` is a no-op at validation time — it documents intent and
  suppresses the frontend's fallback "require all media" behavior.

- **Graph rewriting** (`present.required: false`) says "if the user
  omits this input, disconnect the node". Removal cascades like `ignore`.

If no `validation.inputs` rules exist the frontend falls back to
auto-requiring all non-text media inputs, honoring `present.required: false`.

---

## Mask Processing

Mask processing is authored as a `pipeline` stage of `kind:
"mask_processing"`. The stage does three jobs:

1. Marks mask input nodes so they are **not** shown as primary inputs.
2. Crops source + mask to the mask's bounded region when the user picks
   `crop_mode: "crop"`.
3. Applies a transparency treatment to the source video based on
   `source_video_treatment`.

### Targets

Every `target` explicitly names the source node, the mask node, and what
kind of mask it is:

| Field         | Values                               | Purpose                                                |
| ------------- | ------------------------------------ | ------------------------------------------------------ |
| `source`      | `{ node_id, param }`                 | The workflow input whose video/image is being masked   |
| `mask`        | `{ node_id, param }`                 | The mask input; automatically hidden from primary list |
| `mask_type`   | `"binary"` \| `"soft"`               | How the mask values are interpreted                    |
| `purpose`     | `"video"` \| `"audio_timing"`        | What pipeline stage consumes this pair                 |
| `render_fps`  | integer, optional                    | Override for how the mask is rendered (audio_timing)   |

In the ReTake example there are **two targets with the same `source`**:
one for `purpose: "video"` (drives mask_crop output) and one for
`purpose: "audio_timing"` with `render_fps: 25` (drives audio timing
extraction).

### Controls

Three controls matter for a typical mask stage:

- `crop_mode` — enum `["crop", "full"]`. `"crop"` shrinks the source and
  mask to the mask's bounding box (with padding from `crop_dilation`) so
  generation runs on the minimum relevant region. `"full"` disables
  cropping.
- `crop_dilation` — fractional padding around the detected bounding box.
  Rendered as a percent slider.
- `source_video_treatment` — enum over
  `preserve_transparency | fill_transparent_with_neutral_gray |
  remove_transparency`. Determines how transparent pixels in the source
  video are handled before it is fed through the mask.

Controls may be exposed as widgets (`"expose": "widget"`) or hidden
(`"expose": "none"`). Hidden controls must declare `source: "client"` or
`source: "backend"` so it is unambiguous who is responsible for the value.

---

## Aspect Ratio Processing

`kind: "aspect_ratio"` is the second pipeline stage. It picks a
model-valid (width, height) pair and writes it back into the workflow.

### Config

```json
"config": {
  "stride": 32,
  "search_steps": 2,
  "resolutions": [480, 720, 1080],
  "postprocess": {
    "enabled": true,
    "mode": "stretch_exact",
    "apply_to": "all_visual_outputs"
  }
}
```

| Field                   | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `stride`                | Model's resolution quantum (both width and height are rounded to this)  |
| `search_steps`          | How many stride-multiples to search around the target                   |
| `resolutions`           | Allowed "longest-side" values surfaced to the widget                    |
| `postprocess.enabled`   | Whether to post-stretch outputs back to the requested aspect            |
| `postprocess.mode`      | Currently only `"stretch_exact"`                                        |
| `postprocess.apply_to`  | Currently only `"all_visual_outputs"`                                   |

### Targets

Each target is a pair of `{ width, height }` param refs that receive the
resolved dimensions. Multiple targets are supported for workflows where
several nodes need the same (w, h) — for example a sampler latent size and
a mask resize node.

### Controls

- `target_resolution` — widget enum over the allowed longest-side values.
- `target_aspect_ratio` — hidden, `source: "client"`. The frontend computes
  this from the user's selection UI and submits it per-request. Declaring
  `source` explicitly is required — this is exactly the invariant that
  prevents the value from being silently dropped.

### Stage ordering

`mask_processing` declares `after: ["aspect_ratio"]` because the resolved
(w, h) feeds into the aspect-aware mask crop geometry. There is also a
built-in default (`DEFAULT_PIPELINE_STAGE_AFTER_BY_KIND`) that enforces
this even when `after` is omitted. Authoring it explicitly is the
recommended practice.

---

## Derived Widgets

Derived widgets expose one high-level control that expands into multiple
per-parameter overrides. Three kinds exist today:

### `dual_sampler_denoise`

Maps a 0–1 slider to split-step parameters across a dual-sampler workflow.
Given a denoise value `d` and `total_steps` `T`:

- `denoise_steps = round(d × T)`
- `start_step   = T − denoise_steps`
- `split_step   = max(base_split_step, start_step)`

```json
{
  "id": "denoise",
  "kind": "dual_sampler_denoise",
  "label": "Denoise Strength",
  "total_steps":     { "node_id": "145", "param": "steps" },
  "start_step":      { "node_id": "145", "param": "start_step" },
  "base_split_step": { "node_id": "145", "param": "split_step" },
  "split_step_targets": [
    { "node_id": "145", "param": "split_step" },
    { "node_id": "146", "param": "start_at_step" }
  ]
}
```

Rendered as a percent slider with min/max/step derived from `total_steps`.

### `single_sampler_denoise`

Maps a 0–1 slider to one sampler's `start_at_step` style parameter. Given a
denoise value `d` and `total_steps` `T`:

- `denoise_steps = round(d × T)`
- `start_step = T − denoise_steps`

```json
{
  "id": "single_sampler_denoise",
  "kind": "single_sampler_denoise",
  "label": "Denoise",
  "total_steps": { "node_id": "115", "param": "steps" },
  "start_step": { "node_id": "115", "param": "start_at_step" }
}
```

Rendered as a percent slider from 0 to 1 with step derived from `total_steps`.

### `video_audio_retake`

Three-option enum (`"Video & Audio" | "Video" | "Audio"`) that flips two
boolean bypass switches. Selecting "Video" keeps the video retake active
and flips `audio_bypass`; selecting "Audio" does the opposite; selecting
"Video & Audio" leaves both switches alone.

```json
{
  "id": "retake_mode",
  "kind": "video_audio_retake",
  "label": "Retake",
  "default": "Video & Audio",
  "video_bypass": { "node_id": "705", "param": "switch" },
  "audio_bypass": { "node_id": "714", "param": "switch" }
}
```

The two target switches are typically authored as `hidden: true` so the
derived widget is the only control the user sees.

---

## Effect Switches

`effect_switches` are for panel-state-conditioned graph effects. They are
similar to `rewrites`, but each switch is **first-match-wins**: within one
switch, only the first matching case contributes effects. Separate switches
are independent and compose.

Each matching case can:

- `bypass` node ids, which disconnects their outbound links and removes the
  bypassed nodes when safe.
- `set_widgets`, which writes scalar workflow widget values. Link references
  like `["node_id", 0]` are intentionally left alone.

Use `effect_switches` when a set of cases represents one mutually exclusive
mode. Use `rewrites` when effects should accumulate across every matching
rule.

Example based on `vlo_VACE_inpaint_advanced`: the derived
`single_sampler_denoise` widget controls whether the first sampler branch is
active. Full denoise bypasses nodes `113` and `114`; partial denoise keeps the
branch active and turns on node `114`'s boolean switch.

```json
{
  "effect_switches": [
    {
      "id": "single_sampler_denoise",
      "cases": [
        {
          "when": {
            "kind": "compare",
            "ref": {
              "kind": "derived_widget",
              "derived_widget_id": "single_sampler_denoise"
            },
            "operator": "eq",
            "value": 1
          },
          "bypass": ["113", "114"]
        },
        {
          "when": { "kind": "always" },
          "set_widgets": [
            { "node_id": "114", "widget": "value", "value": true }
          ]
        }
      ]
    }
  ]
}
```

---

## Output Injections

`output_injections` reroutes downstream consumers of one node's output
slot to read from a different source. The shape is a **nested object**
keyed `target_node_id → target_output_index → rule`:

```json
"output_injections": {
  "160": {
    "0": {
      "source": { "kind": "node_output", "node_id": "118", "output_index": 0 },
      "when": {
        "kind": "input_presence",
        "inputs": ["167"],
        "match": "all_missing"
      }
    }
  }
}
```

| Field                    | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| outer key                | `target_node_id` whose output is being rerouted      |
| inner key                | `target_output_index` on the target                  |
| `source.kind`            | `"node_output"` (currently the only kind)            |
| `source.node_id`         | Source node to reroute from                          |
| `source.output_index`    | Output slot on the source (default `0`)              |
| `when`                   | Optional input-presence gate                         |

The engine emits warnings if the target or source node is missing, or if
no downstream consumer matches.

---

## Media Fallbacks

`media_fallbacks` declares backend-supplied media assets that should be
buffered when the request omits a corresponding user input. This is
useful for workflows that intentionally treat an input as "missing" in
their rules, but still need a placeholder asset at execution time.

```json
"media_fallbacks": [
  {
    "kind": "dummy",
    "node_id": "167",
    "input_type": "image",
    "when": {
      "kind": "input_presence",
      "inputs": ["167"],
      "match": "all_missing"
    }
  }
]
```

| Field          | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `kind`         | Built-in fallback behavior, currently `"dummy"`                |
| `node_id`      | Workflow node that should receive the fallback media           |
| `input_type`   | Discoverable input type such as `"image"` or `"video"`         |
| `param`        | Optional explicit node param if the class has multiple inputs  |
| `filename`     | Optional uploaded filename override                            |
| `content_type` | Optional MIME type override                                    |
| `synthetic`    | When `true`, validation still treats the input as user-missing |
| `when`         | Optional `input_presence` gate                                 |

The sidecar declares only that a dummy fallback is needed; the backend
owns the actual placeholder asset. Synthetic fallback media is excluded
from `provided_input_ids`, so rules like `"match": "all_missing"` keep
working even after the backend buffers the placeholder file.

---

## Slots

`slots` declares synthetic input slots that the frontend groups into
higher-level input widgets (e.g. "provide one of N media types"). Each
slot entry mirrors a subset of `present`:

| Field          | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `input_type`   | `"text" \| "image" \| "video" \| "audio" \| ...`           |
| `label`        | Display label                                              |
| `param`        | Parameter name for value injection                         |
| `experimental` | Gated behind an experimental toggle in the UI              |
| `export_fps` / `frame_step` / `max_frames` | Frame selection overrides         |

Slots are referenced by id from node `present` blocks when a node should
appear behind a slot rather than as its own top-level input.

---

## Quick Reference: Per-Node Fields

| Field              | Type                                  | Purpose                                                                 |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| `ignore`           | boolean                               | Remove from the graph entirely (cascading)                              |
| `ignore_overrides` | array of `{ when, value }`            | Conditional `ignore` driven by `ConditionExpression`                    |
| `present`          | object                                | Primary-input presentation (see below)                                  |
| `widgets_mode`     | `"control_after_generate"` \| `"all"` | Widget auto-discovery mode for this node                                |
| `widgets`          | `{ <param>: WidgetEntry }`            | Explicit widget definitions and overrides                               |
| `selection`        | `{ export_fps, frame_step, max_frames }` | Video frame selection for video inputs                               |
| `node_title`       | string                                | Override for auto-derived group title fallback                          |

### `present`

| Field        | Default       | Purpose                                                                               |
| ------------ | ------------- | ------------------------------------------------------------------------------------- |
| `enabled`    | `true`        | Show in the primary input list                                                        |
| `required`   | `true`        | If `false`, node is removed when the user omits the input                             |
| `input_type` | inferred      | `"text" \| "image" \| "video" \| "audio"`                                             |
| `param`      | inferred      | Parameter name on the node for value injection                                        |
| `label`      | node title    | Custom display label                                                                  |
| `class_type` | node's class  | Override for rule-defined inputs                                                      |
| `group_id` / `group_title` / `group_order` | —   | Grouping in the input list                                         |
