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

`runtime.panelUi` is the complete host barrel, including its raw custom-control
registry. Trusted code may also use the DOM and browser APIs directly. When no slot,
zone, or workspace fits without losing important functionality, use raw panel/DOM
integration with explicit `onDispose()` cleanup and document the VLO coupling.

## Select a UI contribution

Register through `context.api.ui`:

- `registerNotice` for host-rendered declarative information;
- `registerComponent` for arbitrary trusted React in a declared slot;
- `registerModal` for a host-owned MUI dialog with extension-owned contents;
- `registerView` for a persistent extension tab in a host-owned shell region.

Current curated component slots are:

- `transformation-panel.before`;
- `generation.toolbar`;
- `generation.inputs.after`;
- `timeline.toolbar`.

Slot IDs are an open SDK string but a closed host catalogue at runtime. Prefer adding
a reusable host mount when the location is generally useful; use trusted raw DOM or
host access for one-off, exploratory, or build-coupled integrations.

Use `openModal(localId, input?)` to open only the caller's modal. Keep input and
result finite JSON. Handle an `undefined` result as cancellation or disposal.
Omitted modal size defaults to `medium`.

Register `kind: "trusted-view"` at `defaultRegion: "right-sidebar"`
(clip/generation editors), `defaultRegion: "left-sidebar"` (an input-source tab
alongside Assets, Text, Composite, Effects, and Transitions), or
`defaultRegion: "projects-page.main"` (a tool available before a project opens).
Use `openView(localId)` to select it. Views mount lazily on first selection, then
remain mounted to preserve state. Observe the `active` prop and pause animation
loops, camera capture, polling, or expensive previews while hidden. User layout
choices win: `openView` returns `false` when the user has hidden the view.

Frontend activation happens before a project opens. Views, commands, menus,
catalogues, backend jobs, and local storage are available there, while
`storage.project` is `null`; timeline and asset operations fail closed. Gate
editor-dependent commands and views with the `project.open` context key.

Render ordinary HTML5 canvas, SVG, WebGL, or browser controls inside a trusted slot,
modal, or view. Keep host navigation, dialog close semantics, and region placement
outside the extension component.

## Context/action menus

Register a command first, then place it with
`ui.menus.addItem({ id, apiVersion: 1, menuId, kind: "command", command, group,
order?, when? })`. Discover current menu IDs and their documentation-grade subject
schemas through `ui.menus.listMenus()`; this includes editor menus and the
pre-project `projects.item.context` menu. The host renders command title/icon and
enablement, and invocation receives the menu's schema-validated subject as detached
JSON. Structured `when` conditions can inspect host context keys or subject paths;
menu placements do not carry visibility or selection callbacks.

## Per-clip timeline overlays

`context.api.timeline.registerClipOverlay({ id, apiVersion: 1, kind: "trusted-overlay",
useItems })` adds badges, markers, or draggable handles to every timeline clip.
`useItems({ clip, isSelected })` is a React hook run on the timeline's hot render
path — obey the Rules of Hooks and keep it cheap. Each item declares `content` (trusted
React), a `placement` (`endpoint` or source-time), optional `onClick`/`onContextMenu`,
and optional `drag` handlers that receive source/visual/presentation tick maths. `clip`
is a detached snapshot; the registration is owner-scoped and removed on deactivation.

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
