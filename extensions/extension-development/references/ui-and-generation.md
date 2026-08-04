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

## Contribute an exclusive player-canvas tool

Register a tool with `ui.canvasTools.register`. The returned local `command` can be
used directly in a keybinding request; the host toolbar projects the same command.
Only one tool is active. While it is active, the host suspends canvas selection,
mask editing, and gizmos; Escape and the Select toolbar item restore host behaviour.

`activate(session)` receives a host-owned transient Pixi `overlay`, coordinate
conversion helpers, and `targetClipId`, captured before host selection pauses. Draw
only previews and cursors in the overlay; the host clears it on deactivation. Handle
normalised `down`/`move`/`up`/`cancel` events in `onPointer`, and commit durable work
through asset ingestion plus timeline entity/mask transactions. Always tolerate a
null target clip, cancellation, contribution disposal, and asynchronous ingest
failure. Do not attach independent listeners to the host stage unless using the
explicit trusted escape hatch.

## Commands and keybindings

The host keeps one command table; menus, keybindings, and the canvas toolbar are
projections of it. Register with
`ui.commands.register({ id, apiVersion: 1, title, icon?, when?, run })` using a
local ID — the host qualifies it as `extensionId/id`. `run(invocation)` receives
`{ source, subject? }`, where `subject` is the detached JSON subject of the
invoking surface.

Gate enablement declaratively with `when` over host context keys rather than
checking inside `run`, so every surface renders the command consistently. Current
keys: `project.open`, `editor.open`, `focus.region`, `playback.playing`,
`selection.clipCount`, `selection.clipType`, `selection.transitionSelected`,
`timeline.canUndo`, `timeline.canRedo`, `timeline.canPaste`. Read one directly
with `ui.commands.getContextKey(key)`; an unknown key returns `undefined`.

Request a chord with
`ui.commands.registerKeybinding({ id, apiVersion: 1, chord, command, regions? })`.
The command must already be registered. `"Mod"` is Ctrl, or Cmd on macOS. A chord
that collides with an existing binding — including chords the host reserves for
its own shortcuts — registers *inactive* with a diagnostic rather than failing
activation, so check your diagnostics if a shortcut appears dead. Omit `regions`
for a global binding; otherwise name the editor focus regions it applies in.

`ui.commands.execute(localId, subject?)` invokes one of your own commands and
resolves `true` when it ran, `false` when its `when` clause was false — a
disabled command is a state of the editor, not an error, so branch on the
result rather than assuming it ran. It throws for an unregistered ID.

Host commands are an authority surface: they execute only if the host opted
that specific command in, and none do today. Contribute a menu placement and
let the user invoke it.

## Option catalogues

A host catalogue is a named option list behind a host dropdown. Discover them with
`ui.catalogues.listCatalogues()`, which returns each `id` with a
documentation-grade `valueSchema`; the host's own validation is authoritative and
rejects a value that does not fit. Contribute with
`ui.catalogues.addOption({ id, apiVersion: 1, catalogueId, label, value, order?,
when? })` — a local `id`, qualified by the host — and read the currently visible
options of a catalogue, host and extension alike, with `ui.catalogues.list(id)`.

Values are cloned and frozen on registration, and `when` gates visibility over
context keys. A catalogue is not a general data bus: contribute only values its
schema describes.

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
