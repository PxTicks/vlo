# UI and generation tools

Use this reference for trusted React contributions, modals, persistent workspaces,
HTML/SVG/WebGL canvases, and ComfyUI workflow-input integration.

## Use host-native React and controls

Obtain React from `context.api.runtime.react`, selected MUI controls from
`runtime.mui`, and native panel controls from `runtime.panelUi`. Use type-only
package imports to improve authoring types, but do not bundle runtime copies of the
host singleton families.

All trusted UI runs with main-page authority. Host error boundaries contain ordinary
render failures and report diagnostics; they are not a security boundary.

## Select a UI contribution

Register through `context.api.ui`:

- `registerNotice` for host-rendered declarative information;
- `registerComponent` for arbitrary trusted React in a declared slot;
- `registerModal` for a host-owned MUI dialog with extension-owned contents;
- `registerWorkspace` for a persistent extension tab in a host-owned dock.

Current curated component slots are:

- `transformation-panel.before`;
- `generation.toolbar`;
- `generation.inputs.after`.

Slot IDs are an open SDK string but a closed host catalogue at runtime. Do not invent
a slot without adding a corresponding host mount and declaration.

Use `openModal(localId, input?)` to open only the caller's modal. Keep input and
result finite JSON. Handle an `undefined` result as cancellation or disposal.
Omitted modal size defaults to `medium`.

Register `kind: "trusted-workspace"` at `location: "right-sidebar"` for a larger
editor. Use `openWorkspace(localId)` to select it. Workspaces mount lazily on first
selection, then remain mounted to preserve state. Observe the `active` prop and pause
animation loops, camera capture, polling, or expensive previews while hidden.

Render ordinary HTML5 canvas, SVG, WebGL, or browser controls inside a trusted slot,
modal, or workspace. Keep host navigation, dialog close semantics, and dock placement
outside the extension component.

## Read and write generation inputs

Call `context.api.generation.listInputs()` during user-driven UI work to obtain
detached active workflow inputs. Do not assume a fixed ComfyUI node ID; select by
returned ID and present labels when multiple text inputs exist.

Commit text changes with one synchronous labelled
`context.api.generation.transaction(label, callback)` and `setTextInput`. Inspect
the result:

- `unavailable` means the generation panel adapter is not mounted or activation
  ended;
- missing or non-text inputs fail without partial writes;
- asynchronous callbacks are invalid.

A modal can outlive the generation tab. On failure, retain user work, show the result
message, and allow retry or cancellation rather than throwing or closing blindly.

Keep vendor-specific prompt dialects in extensions. Prefer a versioned internal
layout model and translate it to the chosen model's JSON only at commit time.

## Compose AI UI with other domains

Use `assets.readBlob` and backend artifact/job APIs for model work. Use timeline
transactions for persisted editor changes. Keep previews local and non-mutating until
the user applies them. Do not turn a UI contribution into a second generation or
timeline mutation system.
