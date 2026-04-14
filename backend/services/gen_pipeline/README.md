# Generation Pipeline

This document describes the end-to-end generation pipeline — an ordered set
of processors that spans the frontend and the backend. The frontend
collects and normalizes user inputs, the backend rewrites the workflow
graph and dispatches to ComfyUI, and the frontend finalizes the outputs
into importable assets.

For sidecar authoring (how to write a `*.rules.json` file to control what
the user sees in the Generate panel and how the workflow is transformed),
see [AUTHORING.md](AUTHORING.md).

---

## End-to-End Phase Overview

A single generation passes through five phases:

1. **Frontend preprocess** — collect inputs from the UI, normalize
   timeline selections, render derived masks, compute `target_aspect_ratio`,
   assemble a `GenerationRequest` with `pipeline_inputs` for every
   pipeline stage that owns client-authored controls.
2. **Backend preprocess** — load rules, validate, resolve derived widgets
   and pipeline controls, rewrite the graph, run stage processors, upload
   media.
3. **Dispatch** — submit the prepared workflow to ComfyUI.
4. **Backend postprocess** — enrich the ComfyUI response with
   `workflow_warnings`, applied widget values, and `pipeline_outputs`.
5. **Frontend postprocess** — fetch generated files, optionally stitch
   frames+audio, apply exact-aspect-ratio resize, and import the results
   as assets.

Each processor reads from and writes to a phase-specific context
(`FrontendPreprocessContext`, `BackendPipelineContext`,
`FrontendPostprocessContext`). Runners execute processors sequentially
inside each phase.

The two handoff envelopes between frontend and backend are both typed:

- **Frontend → backend**: `GenerationRequest.pipelineInputs: Record<stageId,
  Record<controlKey, unknown>>`. Only controls declared in the sidecar with
  `source: "client"` participate.
- **Backend → frontend**: `PromptResponse.pipeline_outputs: Record<stageId,
  Record<string, unknown>>`. Stage processors write here (e.g.
  `aspect_ratio_processing`, `mask_crop_metadata`, `processed_mask_video`).

---

## Frontend Preprocess

Implemented by `runFrontendPreprocess` in
[`frontend/src/features/generation/pipeline/runPreprocess.ts`](../../../frontend/src/features/generation/pipeline/runPreprocess.ts)
with processors listed in
[`pipeline/preprocessors/index.ts`](../../../frontend/src/features/generation/pipeline/preprocessors/index.ts).

Execution order:

| Step | Processor                  | Purpose                                                                              |
| ---- | -------------------------- | ------------------------------------------------------------------------------------ |
| 1    | `collectTextInputs`        | Route text slot values onto `ctx.textInputs`                                         |
| 2    | `collectImageInputs`       | Route image slot values onto `ctx.imageInputs`                                       |
| 3    | `collectAudioInputs`       | Route audio slot values onto `ctx.audioInputs`                                       |
| 4    | `collectVideoInputs`       | Normalize timeline selections to WebM; render derived masks alongside source videos  |
| 5    | `prepareAspectRatioInputs` | Resolve effective `target_aspect_ratio`; optionally crop visual inputs to that ratio |

### `GenerationPlan` vs. prepare

`createGenerationPlan` ([pipeline/generationPlan.ts](../../../frontend/src/features/generation/pipeline/generationPlan.ts))
snapshots the UI state (workflow, slot values, derived mask mappings,
widget inputs + modes, postprocess config, aspect-ratio choice, etc.) into
a serializable `GenerationPlan` up front. `prepareGenerationPlan` then
runs the preprocess phase against that snapshot to produce a
`GenerationRequest`.

The split matters for **queued batches**: the plan carries
`widgetModes` rather than realized random values, so each dequeued
generation re-runs preprocess and the backend resolves `"randomize"` per
request — queued generations get fresh seeds instead of a shared one.

### Derived mask rendering

`collectVideoInputs` is where the derived-mask mappings declared in the
sidecar become real media. For each mapping it renders the mask video
from the user's timeline selection, interleaved with the source video so
both streams use the same frame timing. The rendered mask files are
later uploaded through the normal video-input path.

### Aspect-ratio preflight

`prepareAspectRatioInputs`:

1. Resolves the `target_aspect_ratio` string (either the project's
   configured AR, or the AR inferred from the first visual input — the
   "exact" toggle in the UI).
2. If exact-aspect-ratio is enabled, pre-crops uploaded images/videos to
   that aspect. This ensures the backend's aspect stage picks a valid
   `(width, height)` that matches what the user actually submitted.

### `pipeline_inputs` assembly

After the processors run, `buildPipelineInputs` projects context values
into the per-stage envelope the backend consumes. Today:

| Stage                 | Populated keys                                                                   |
| --------------------- | -------------------------------------------------------------------------------- |
| `aspect_ratio`        | `target_aspect_ratio`, `target_resolution` (each included only if declared as a control on the stage) |
| `mask_processing`     | `crop_mode`, `crop_dilation` (only when there are derived mask mappings)         |

The frontend never hardcodes control keys onto arbitrary stages — it
only writes values for controls that actually exist in the sidecar,
which it probes via `getWorkflowStageControl`. A sidecar that omits
`target_aspect_ratio` entirely will silently receive no client value.

---

## Backend Preprocess Order

Defined by `build_backend_preprocessors` in
[processors/__init__.py](processors/__init__.py):

| Step | Processor                         | Reads from sidecar                                        |
| ---- | --------------------------------- | --------------------------------------------------------- |
| 1    | `inject_values`                   | —                                                         |
| 2    | `load_rules`                      | whole sidecar                                             |
| 3    | `validate_inputs`                 | `validation.inputs`                                       |
| 4    | `resolve_derived_widgets`         | `derived_widgets`                                         |
| 5    | `validate_widgets`                | `nodes.*.widgets`                                         |
| 6    | `apply_rules`                     | `nodes`, `output_injections`, `slots`                     |
| 7    | `widget_overrides`                | `nodes.*.widgets`                                         |
| 8    | `resolve_pipeline_controls`       | `pipeline[*].controls`                                    |
| 9    | `pipeline_stages` (`before_upload`) | enabled stages registered at the `before_upload` checkpoint |
| 10   | `upload_media`                    | —                                                         |
| 11   | `pipeline_stages` (`after_upload`) | enabled stages registered at the `after_upload` checkpoint |

### `inject_values`

Reads form-submitted input values onto the context before any rules are
loaded. No sidecar is required.

### `load_rules`

Loads and parses the sidecar via `load_rules_model_for_workflow` in
[../workflow_rules/normalize.py](../workflow_rules/normalize.py):

- Missing sidecar → defaults, no warnings.
- Malformed JSON → defaults + `invalid_rules_json` warning.
- Schema-invalid fields → defaults + pydantic-derived warnings. Generation
  is not failed; field-level fallbacks are applied.

Sidecar resolution order: `workflows_dir/<stem>.rules.json`, then each of
`fallback_workflow_dirs` in order. In production these are wired to
`backend/assets/workflows/` (user-authored + saved) and
`backend/assets/.config/default_workflows/` (packaged) respectively — see
[AUTHORING.md](AUTHORING.md) for the author-facing view.

### `validate_inputs`

Evaluates the three rule kinds in `validation.inputs` against the submitted
inputs. References are compact strings of the form `"node_id"` or
`"node_id:param"`.

| Kind           | Fails when                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `required`     | The named input is missing                                              |
| `at_least_n`   | Fewer than `min` of the listed inputs are present                       |
| `optional`     | Never — documents that an input may be omitted                          |

Failures produce warnings and abort the request before any graph rewrite.

### `resolve_derived_widgets`

Expands each entry in `derived_widgets` into concrete widget overrides. A
derived widget is submitted as `derived_widget_<id>` and has a `kind`
discriminator:

- `dual_sampler_denoise` — maps a single 0–1 denoise value `d` with total
  steps `T` to `start_step = T − round(d·T)` and
  `split_step = max(base_split_step, start_step)`. Emits overrides for every
  `split_step_targets` reference.
- `video_audio_retake` — a three-option enum (`"Video & Audio" | "Video" |
  "Audio"`) that drives two boolean bypass widgets. The unselected channels
  have their bypass switch flipped; the selected channel is left alone.

Expansion happens before `validate_widgets` so derived values participate in
widget validation like any authored override.

### `validate_widgets`

Cross-checks submitted widget values against the resolved widget schema
(min/max/options/value_type). Violations produce warnings; out-of-range
numeric values are clamped.

### `apply_rules`

Performs graph-level rewrites:

- **`output_injections`** — reroutes downstream consumers of a `target_node_id`
  (at `target_output_index`) to read from a different `source`. Optional
  `when` conditions gate the reroute by input presence. Emits warnings if the
  source or target is missing, or no downstream consumer was matched.
- **`ignore: true` nodes** — disconnected and removed. Removal cascades: a
  parent whose last consumer just disappeared is also removed, recursively.
- **Optional inputs (`present.required: false`)** — when the user did not
  provide the input, the corresponding node is removed with the same cascade.
- **`ignore_overrides`** — conditional `ignore` flips driven by input
  presence.

### `widget_overrides`

Applies form-submitted widget values (`widget_<nodeId>_<param>`) and
randomization directives (`widget_mode_<nodeId>_<param>` = `"fixed" |
"randomize"`) onto the workflow JSON. Ranges for randomization come from the
resolved widget entry.

### `resolve_pipeline_controls`

Resolves the value of every `pipeline[*].controls[*]` entry for the current
run. This is the single authority for how a control value is chosen:

1. If `source == "client"` and a form submission is present
   (`pipeline_input_<stage_id>_<key>`), use it.
2. Otherwise walk `default_rules` top-down; the first rule whose `when`
   condition matches contributes its `value`.
3. Otherwise use the static `default`.

`when.ref` can point either at a workflow param (`workflow_param`) or at
another pipeline control (`pipeline_control`). References between controls
are validated at schema load for cycles, unknown targets, and duplicate
keys.

Resolved values land on the context keyed by `(stage_id, key)` and are
consumed by stage processors in the `pipeline_stages` phases.

### `pipeline_stages` (checkpoints)

`create_pipeline_stage_processor` produces a processor bound to a named
**checkpoint** (`before_upload` or `after_upload`) and a map of
`stage_kind → stage_processor`. At run time it walks `rules.pipeline` in
authored order, honoring `after` dependencies plus the built-in contract
that `mask_processing` runs after `aspect_ratio`. For each enabled stage
whose kind has a registered processor at the current checkpoint, it invokes
the processor with the resolved controls for that stage.

Currently registered:

| Checkpoint      | Stage kind        | Processor                                                   |
| --------------- | ----------------- | ----------------------------------------------------------- |
| `before_upload` | `aspect_ratio`    | `aspect_ratio` — computes the nearest valid resolution within `config.resolutions` under `stride` and `search_steps`, writes `(width, height)` to every target pair |
| `before_upload` | `mask_processing` | `mask_crop` — analyzes mask bounds, crops source and mask to the bounded region when `crop_mode = "crop"`, applies `source_video_treatment` |

`output_assembly` is authored but has no backend-side processor — its
`config` is surfaced to the frontend via `pipeline_outputs`.

### `upload_media`

Uploads every prepared input media buffer to ComfyUI and rewrites the
corresponding node params to reference the returned filenames. Buffers may
have been mutated by `before_upload` stages (e.g. aspect-ratio-aware mask
cropping by `mask_crop`).

---

## Dispatch

Implemented by `create_submit_prompt_processor` in
[processors/submit_prompt.py](processors/submit_prompt.py). Submits the
prepared workflow to ComfyUI and stores the raw HTTP response on the
context. This is modeled as a distinct phase so preprocess and dispatch
have an explicit boundary.

---

## Backend Postprocess

Implemented by `finalize_backend_response()` in
[../comfyui/comfyui_generate.py](../comfyui/comfyui_generate.py).

Intentionally lightweight:

- Non-JSON ComfyUI responses pass through unchanged.
- Raw JSON responses are preserved when there is no backend metadata to
  attach.
- JSON responses are enriched with `workflow_warnings`, the applied widget
  values, and `pipeline_outputs` (e.g. `output_assembly` config, mask
  crop rectangles) when present.

---

## Frontend Postprocess

Implemented by `runFrontendPostprocess` in
[`frontend/src/features/generation/pipeline/runPostprocess.ts`](../../../frontend/src/features/generation/pipeline/runPostprocess.ts)
with processors listed in
[`pipeline/postprocessors/index.ts`](../../../frontend/src/features/generation/pipeline/postprocessors/index.ts).

Execution order:

| Step | Processor           | Purpose                                                                             |
| ---- | ------------------- | ----------------------------------------------------------------------------------- |
| 1    | `fetchOutputs`      | Download every generated file from ComfyUI; bucket into frames / audio / video      |
| 2    | `frameAudioStitch`  | When `mode == "stitch_frames_with_audio"`, package frames + audio into one video    |
| 3    | `aspectRatioResize` | Apply configured exact-dimension resize (`stretch_exact`) to visual outputs         |
| 4    | `importAssets`      | Import the final files as project assets with generation metadata + auto-family key |

### What it consumes from the backend

`buildSubmittedGeneration` ([pipeline/generationPlan.ts](../../../frontend/src/features/generation/pipeline/generationPlan.ts))
is the seam where the backend response feeds into the postprocess
context. From `PromptResponse` it reads:

- `pipeline_outputs[aspectRatioStage.id].aspect_ratio_processing` —
  drives `aspectRatioResize`.
- `pipeline_outputs[maskProcessingStage.id].mask_crop_metadata` —
  attached to generation metadata for downstream crop-aware tooling.
- `pipeline_outputs[maskProcessingStage.id].processed_mask_video` —
  base64 WebM of the post-processed mask; decoded into a `File` and
  ingested as a standalone asset by `importAssets` so outputs can link
  back to it via `generationMaskAssetId`.
- `applied_widget_values`, `comfyui_prompt`, `comfyui_workflow` —
  merged into the creation metadata.
- `workflow_warnings` — surfaced in the generation record.

### Stitch and on-failure behavior

`frameAudioStitch` honors the `output_assembly` config surfaced via
`pipeline_outputs`:

- `mode: "auto"` — stitch if the workflow emitted a coherent
  frame+audio set, otherwise pass frames and audio through separately.
- `mode: "stitch_frames_with_audio"` — always stitch.
- `mode: "none"` — skip stitching entirely.
- `on_failure: "fallback_raw"` — on a stitch error, keep frames/audio as
  separate imported assets.
- `on_failure: "show_error"` — surface the error to the UI instead of
  falling back.
- `stitch_fps` — overrides the per-selection FPS when stitching.

### Exact-aspect resize

`aspectRatioResize` is only active when `aspect_ratio_processing.mode ==
"stretch_exact"` and `apply_to == "all_visual_outputs"`. It resolves the
target dimensions from `aspect_ratio_processing` and resizes every
fetched visual file plus any packaged stitched video. The prepared mask
is resized too so mask-aware tooling stays in sync.

### Import

`importAssets` is the terminal step. It ingests the post-processed
outputs (plus the prepared mask as a separate asset, if present) into
the project, attaches the full `GeneratedCreationMetadata`, and computes
the auto-family match key so subsequent generations from the same
surface land in a consistent family.

---

## Stage Contract

A pipeline stage is an authored entry under `rules.pipeline`. The shared
shape (see [`WorkflowPipelineStageBase`](../workflow_rules/schema/models.py)):

- `id` — unique within the sidecar, referenced by `pipeline_inputs` /
  `pipeline_outputs` and by other stages' `after`.
- `kind` — discriminator: `mask_processing`, `aspect_ratio`, or
  `output_assembly`.
- `enabled` — optional, defaults to `true`.
- `label` / `description` — optional author-facing metadata.
- `after` — optional dependency list. Entries may be stage `id`s or unique
  stage `kind`s. The schema enforces no cycles, no unknown references, and
  no self-dependencies.
- `controls` — list of `PipelineControl` entries. Each control has a unique
  `key` within its stage.

Stage-kind-specific fields:

- `mask_processing.targets: list[{ source, mask, mask_type, purpose,
  render_fps? }]`.
- `aspect_ratio.config: { stride, search_steps, resolutions, postprocess }`
  and `aspect_ratio.targets: list[{ width, height }]`.
- `output_assembly.config: { mode, panel_preview, on_failure, stitch_fps? }`.

---

## Pipeline Control Contract

Every control declares both how it is presented (`expose`) and who authors
its value (`source`):

| `expose`   | `source` allowed       | Notes                                                                  |
| ---------- | ---------------------- | ---------------------------------------------------------------------- |
| `"widget"` | `"client"` (enforced)  | Rendered as a widget; value comes from the form                        |
| `"none"`   | `"client"` or `"backend"` | Hidden control; must state explicitly whether the client still submits it |

Exposing a control as a widget with `source != "client"` is a schema error.
Exposing as `"none"` with no `source` is also a schema error. This
invariant exists to prevent the class of bug where a frontend-submitted
value (e.g. `target_aspect_ratio`) is silently dropped because nothing
declared who owns it.

Controls may `bind` to another value (`workflow_param` or
`pipeline_control`). The bound value is the effective default unless
overridden by `default_rules` or, for `client` controls, by a form
submission.
