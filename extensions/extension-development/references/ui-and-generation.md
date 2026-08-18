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

Register `kind: "trusted-view"` at one of five `defaultRegion` values:

- `"right-sidebar"` — clip and generation editors;
- `"left-sidebar"` — an input-source tab alongside Assets, Text, Composite,
  Effects, and Transitions;
- `"projects-page.main"` — a tool available before a project opens;
- `"player-aside"` — a column beside the player canvas, for tools that have to
  sit next to the picture. It takes no space until something registers there;
- `"bottom-dock"` — the dock between the player and the timeline, where the
  video scopes live.

Use `openView(localId)` to select it. Views mount lazily on first selection, then
remain mounted to preserve state. Observe the `active` prop and pause animation
loops, camera capture, polling, or expensive previews while hidden. User layout
choices win: `openView` returns `false` when the user has hidden the view.

The bottom dock is the one region that starts **closed** — an empty selection is
its closed state, unlike the sidebars, which always show something. A view you
register there is not visible until `openView` or the user opens the dock, so do
not treat registration as "on screen".

## Contribute a video scope

`ui.scopes.register({ id, apiVersion: 1, kind: "trusted-scope", label, width,
height, order?, render })` adds a tab to the bottom dock beside the host's
waveform, parade, vectorscope, and histogram — they go through the same registry,
so ordering is one comparison over one table rather than host-first.

`render({ context, width, height, frame })` receives a host-owned 2D context,
already sized and cleared, and `frame.pixels`: **premultiplied** RGBA bytes of
the composited picture. Undo alpha before measuring luma. The buffer belongs to
the host and is valid only for that call — copy anything you need to keep. State
the resolution you draw at through `width`/`height` (16 to 2048 each); the dock
scales the result to the available width.

`render` runs on a sampling loop several times a second while the dock is open.
Keep it synchronous and allocation-light. A throw is caught and reported once,
then suppressed until the scope draws again, so check your diagnostics if a
scope goes blank rather than expecting a crash.

## Report long-running work

`ui.notifications` is where work that takes longer than a click reports to.

- `toast({ message, tone?, durationMs? })` for something that happened.
  `durationMs: 0` keeps it until dismissed; the default auto-dismisses.
- `task({ title, message?, progress?, onCancel? })` for something that *is*
  happening. `update({ message?, progress?, tone? })` leaves omitted fields
  alone, and `progress: null` goes back to indeterminate. Finish with
  `settle({ message?, tone? })`, which replaces the entry with a toast, or
  `settle()` to end it silently.

Supplying `onCancel` shows a cancel affordance. The host calls it and **leaves
the task in place**: cancelling asks your work to stop, and only your work knows
when it has — settle the task once it actually does.

Everything you post is removed when you deactivate, so a package that dies
mid-task cannot leave a spinner behind. One extension may hold at most 16 live
entries at a time; exceeding that throws rather than burying the editor.

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
host keys: `project.open`, `editor.open`, `focus.region`, `playback.playing`,
`selection.clipCount`, `selection.clipType`, `selection.transitionSelected`,
`timeline.canUndo`, `timeline.canRedo`, `timeline.canPaste`. Read one directly
with `ui.commands.getContextKey(key)`; an unknown key returns `undefined`.

Publish state of your own with `ui.commands.setContextKey(key, value)`. The host
qualifies it as `extension.<yourId>.<key>` and returns that name, which is what
any `when` clause must use — yours or another package's. Host keys stay
host-owned: you can add to the editor's vocabulary, not redefine `project.open`.
Values are finite JSON, `undefined` clears a key, and every key you wrote is
cleared when you deactivate, so a stale state cannot outlive the package that
meant it. This is the smallest way two packages compose: one publishes a state,
the other gates a command on it, and neither touches the timeline model.

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

## Read the mounted workflow reactively

`generation.getSession()` returns a detached snapshot of the mounted workflow, or
`null` when no generation panel is mounted. It carries the workflow's identity
(`sourceId`, `instanceId`, `revision`, `fingerprint`, `mode`), a `status` of
`loading`/`ready`/`error`, the panel inputs, `canSubmit`, `busy`, and the node
catalogue: each node's `id`, `classType`, `title`, `mode`, and widgets.

`instanceId` is `null` until the ComfyUI bridge reports identity, and a node `id`
is an execution ID — `<id>` at the root, `<instanceId>:<innerId>` inside a
subgraph instance. Match nodes by `classType` and widget metadata. There are no
inputs, ports, or links in the snapshot, so you cannot tell how a node is wired;
do not infer it from ordering or titles.

Each widget reports `valueType`, `value`, `defaultValue`, `options`, `min`,
`max`, `step`, `linked`, and `editable`. Only an `editable` widget has a panel
control behind it and can be written with `setWidget`; the rest are readable
metadata. For an editable widget the published constraints are the ones a write
is judged against, and `null` options or bounds mean unrestricted, not unknown.
Where more than one control is bound to the same widget the constraints are
their union — the host accepts a value if any of those controls accepts it — so
a published range can be wider than any single control's.

Snapshots are bounded in every dimension, including totals across the whole
snapshot. A very large catalogue is truncated, an oversized value is published
as `null`, and an oversized prompt input is published without its `value`
rather than shortened; each comes with a diagnostic saying so. Do not treat the
absence of a node or an option as proof the workflow lacks it without checking
your diagnostics.

`subscribe(listener)` is payload-free and pairs with `getRevision()`, so the pair
goes straight into `useSyncExternalStore`. The same snapshot object is returned
until something changes, and the subscription is removed on deactivation:

```tsx
function useGenerationSession(api: ExtensionGenerationApi) {
  return React.useSyncExternalStore(api.subscribe, api.getSession);
}

function LoaderPicker({ api }: { api: ExtensionGenerationApi }) {
  const session = useGenerationSession(api);
  const loaders = React.useMemo(
    () =>
      (session?.workflow.nodes ?? []).filter(
        (node) => node.classType === "LoraLoader",
      ),
    [session?.workflow],
  );
  if (!session) return null;
  // …render `loaders`, and write with api.transaction(...)
}
```

Register that component through `context.api.ui.registerComponent()` in the
`generation.inputs.after` slot and close over `context.api.generation`; there is
no separate generation panel API.

## Write a workflow widget

`setWidget({ nodeId, widget }, value)` sits alongside `setTextInput` in the same
labelled transaction and follows the same rule: every command validates before
any applies. Values are finite JSON and bounded, and the host validates them
against the widget's own type, enum, and range. Three refusals are worth
branching on:

- `widget_not_found` — the mounted workflow has no such widget; re-read the
  session rather than retrying;
- `widget_not_editable` — the widget exists but the panel exposes no control for
  it, so this write cannot reach the prompt;
- `widget_value_invalid` — wrong type, or outside the enum or range the snapshot
  publishes.

Write a widget when the user is choosing a value in your UI. Do not write on a
timer, on every keystroke, or to enforce policy at submission time.

## Contribute graph effects to a submission

Policy that must hold for the *submitted* graph belongs in a contributor, not in
a widget write:

```ts
context.api.generation.registerSubmissionContributor({
  id: "loader-policy",
  apiVersion: 1,
  contribute: ({ session }) => {
    const loaders = session.workflow.nodes.filter(
      (node) => node.classType === "LoraLoader",
    );
    return loaders.flatMap((node) =>
      selection[node.id] === "none"
        ? [{ kind: "bypass-nodes" as const, nodeIds: [node.id] }]
        : [
            {
              kind: "set-widget" as const,
              target: { nodeId: node.id, widget: "lora_name" },
              value: selection[node.id],
            },
          ],
    );
  },
});
```

`contribute` runs **once per submission**, synchronously, against the session
that submission is planned from. What it returns is stored in the queued plan
and replayed from there, so it is never asked again: a queued generation keeps
the policy it was queued with even after your UI state changes, the user
switches workflow, or your package is disabled. Do not read the clock, a random
source, or live state you have not been handed — the same context must produce
the same effects.

Plan only from `context.session`, never from a snapshot you captured earlier.
The host pins a contribution to the workflow it was planned against and refuses
it if that is not the workflow being submitted, because a node id means
something different in a different workflow.

Effects address the graph rather than the panel, which is what makes them
different from `setWidget`: they can reach a widget with no panel control, and
`bypass-nodes` has no transaction equivalent at all. Node ids are the execution
ids the snapshot publishes, including `<instanceId>:<innerId>` inside a
subgraph instance. A target inside a subgraph definition that is instantiated
more than once, or a widget promoted to the enclosing instance, fails closed —
write the enclosing instance instead.

A contribution is all-or-nothing. If your callback throws, returns something
that is not an array of effects, exceeds a bound (64 effects, 256 bypass
targets per effect, 512 characters per node id or widget name, 100,000
serialized characters per value), names a node the workflow does not contain,
or writes a value the widget's own metadata rejects, the whole contribution is
refused and the submission fails before preprocessing — ahead of any GPU-bound
work — attributed to your contribution. That is deliberate: generating without the
policy the user set up would produce a result they did not ask for. Validate
against the snapshot you were given, and prefer contributing nothing to
contributing something you are unsure of.

Where your effect and a workflow rule write the same widget, yours wins and the
host records a collision diagnostic naming both. The registration is
owner-scoped: it disappears on deactivation, and disposing it removes the
policy from later submissions, never from queued ones.

## Compose AI UI with other domains

Use `assets.readBlob` and backend artifact/job APIs for model work. Use timeline
transactions for persisted editor changes. Keep previews local and non-mutating until
the user applies them. Do not turn a UI contribution into a second generation or
timeline mutation system.
