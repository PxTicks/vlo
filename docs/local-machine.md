# Local-machine adaptation

This checkout is the original PxTicks/vlo application. Local-machine mode adds
a shared host seam: REST transport dispatches the existing project store,
public asset/timeline APIs, generation store and installed export controller.
It does not replace the editor or invoke an extension owner-bound adapter.
No SDK shape or version changes are required.

Enable with `VLO_LOCAL_MACHINE=1`. Defaults:

| Role | Path |
| --- | --- |
| Native projects/assets/exports | `E:\Media\VLO\Project` |
| ML caches | `E:\Media\VLO\Temp` |
| Read-only references | `E:\Media\Rubyapp\KeyAsset` |
| Runtime state, workflow imports, receipts | `E:\Media\VLO\.state` (`VLO_LOCAL_STATE`) |
| Existing ComfyUI | `http://127.0.0.1:8188`, `D:\ComfyUI` |
| Brain and Library bridge | `http://127.0.0.1:5679/api/v1/machine` |

The local HTTP filesystem implements the protocol used by VLO's existing
FileSystemService. Browser folder/save pickers cannot redirect project or export
files outside the shared workspace in this mode. Writes are transactional;
exports upload positional chunks to a staging file before an atomic commit.
References cannot be modified through this API. Paths are checked after
resolution to refuse traversal and junction/symlink escapes.

Only workflow prefixes `vlo_minimax_h3_` and `vlo_qwen_image_2_1_` are exposed
by default. `VLO_ENABLED_WORKFLOW_PREFIXES` permits reviewed future additions.
Packaged workflows remain intact. Model downloads are disabled in this mode;
missing model/node readiness is still reported by the original generation path.
Submission requires positive family evidence from actual executable node types
and every generative checkpoint loader. An allowed filename, title or prompt
cannot authorize an unrelated or mixed model graph. Future additions require
both workflow prefixes and explicit `VLO_MODEL_FAMILY_PATTERNS` JSON mappings.

## Native editor command contract

The browser editor must be open. One tab owns automation; other tabs receive
an explicit conflict. A disconnected editor cannot silently replay an in-flight
generation. All endpoints are loopback-only and reject remote browser origins.

1. `GET /api/machine/status` checks mode, roots and editor connection.
2. `GET /api/machine/capabilities` lists available commands.
3. `POST /api/machine/commands` with `{ "command": "state", "args": {} }`
   returns HTTP 202 and a command ID, not a completed operation.
4. `GET /api/machine/commands/{id}` returns pending/running/succeeded/failed,
   result and error. Poll until a terminal outcome.

`state` returns real project/assets/timeline/generation/export state and JSON
schemas for every command. Commands include create/open/save/configure project,
shared-root import, insert/remove/split/move clips, workflow loading,
generation inputs/start/cancel, and export start/status/cancel.
Timeline positions use VLO's canonical ticks, not seconds. Generation needs real
workflow input IDs and existing asset IDs. `generation.start` reports submission;
`export.start` reports the native run ID. Completion must be inspected separately.
Range exports land in the native project asset library. The normal full-project
export button writes to the project's `exports` folder.

`host.execute` is limited to host entries already opted into programmatic
execution through the shared command table, awaits their native handler and
reports failures. It cannot run arbitrary JavaScript or shell commands.

`/api/machine/bridge/*` relays only the local brain/model and Ruby Library/use
routes. Brain choices use the subscription CLIs or the installed local backend;
this checkout contains no cloud keys. Provider/model/Effort availability is
validated by that local bridge, and unavailable models remain errors.
The native brain panel returns each tool result to the selected model, including
real generated IDs and failures, and continues to a final response. The loop is
bounded to 12 decisions and 64 native tool calls; reaching either ceiling fails
explicitly while preserving changes already acknowledged by the original editor.
Proxy and preset-import calls carry `X-Machine-App: vlo` for Ruby actor attribution.
The panel loads Active presets through the catalogue and preserved use session.
Other reads accept native Ruby requests such as `index:kind=doc`, `toc:doc-id`,
`doc-id#section`, `prompt:id`, `skill:id` and `cases:category/slug`.

`GET /api/machine/library/presets/{preset_id}/schema` reads the current Active
entry, native Ruby control schema and per-card shot capabilities.
`GET /api/machine/library/presets` classifies current Active cards from their
actual executable graphs and returns concise eligible entries. The picker
refreshes that list; it does not infer family from a preset name or optional
catalogue metadata. Continuation choices use the owner's possible kinds.
controls come from `standard`/`advanced` and their `bound_to` roles, so new cards
and changed controls do not require preset-ID branches or edited settings.
`POST /api/machine/library/workflow` accepts `{preset_id,ruby_project,shot?,
expected_source_hash?}`. `shot` uses the native Shot vocabulary (prompt,
duration_s, aspect, resolution, references, extend_from, extend_kind,
first_frame, last_frame, shot_frames, seed, steps, advanced, etc.); model is
restricted to `comfyui`, and unknown top-level or shot fields are refused.
Project and preset are supplied by the enclosing import, never silently ignored.

For configured imports, native `POST /api/shots/preview` returns Ruby's Bound
values and notes. The adapter then imports the original installed Ruby
`registry.load_card(...).build(values)` under an isolated package name. This
retains the owner's reference pruning, duration, keyframe and protected-head
rules. Selected media stays under configured shared E read roots and is handed
over with the original `ComfyClient.upload_image(kind="temp")`; no prompt is
submitted, no owner application is booted, and no model or GPU runner is loaded.
Extend cards require an actual source clip and cannot import raw QA defaults.
Native preview notes marked `blocked` refuse the import before opening a use
session or handing media over. Their original fields/messages remain visible;
the adapter never switches off speech, subtitles or project policy silently.

Imports return `workflow_id`, `library_use_id`, original `receipt`, `card`,
`preview`, `source_hash`, `source_revision` and `bound_graph_sha256`. New imports
use distinct filenames for changed source/bound bytes. Receipts pin those bytes
and the owner's consultation. `GET /api/machine/library/workflows/{id}/validate`
and the native generation endpoint refuse missing receipts, altered imported
files and changed/inactive source cards. Refresh and reimport for a new job;
already submitted native jobs retain their captured graph instead of switching
to a newer Library version mid-render. Earlier raw imports need reimport.

API preset loading confirms the exact executable prompt returned by native
ComfyUI after import. For imported float widgets that the editor rounds, only
that widget's rounding is disabled and its original value is reapplied; native
minimum and maximum bounds stay in force. Class IDs, links and executable values
must still match exactly before VLO acknowledges the workflow as loaded.

Validation must include backend containment/lease tests, native dispatch tests,
frontend build and extension-surface review. Live GPU generation and all five
external clients require separate end-to-end verification before claiming those
paths are qualified.
