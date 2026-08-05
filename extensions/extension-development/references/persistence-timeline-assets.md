# Persistence, timeline, and assets

Use this reference for `context.api.payloadProviders`, `context.api.timeline`, and
`context.api.assets`, including tracking coordinate/time conversion. Verify exact definitions in
`packages/extension-sdk/src/index.ts`.

## Model extension-owned data

Persist provider data in `ExtensionPayload`:

- set `extensionId` to the owning extension;
- namespace `typeId` within that extension;
- increment `schemaVersion` when the data contract changes;
- keep `data` finite `JsonValue`;
- expose host asset IDs through `assetReferences`.

Register through `context.api.payloadProviders` for persistence-only data. Supply current
`schemaVersion`, semantic `validate`, optional forward `migrate`, and optional
`getAssetReferences`. Make migrations increase versions and return untouched finite
JSON. Validate the final migrated representation.

Use `context.api.entityProviders` instead when the same payload also creates rendered content;
it incorporates the payload-provider contract.

Treat asset references as dependencies, not exclusive ownership. Removing a clip
does not imply deleting referenced library assets.

## Read detached timeline state

Use `timeline.listEntities()`, `listClips()`, `listTracks()`, `listTransitions()`,
`listClipMasks(clipId)`, and `getProject()` for activation, commands, and
user-driven UI. These methods return detached snapshots and may clone payloads;
never poll them from render or audio hot paths.

Use `listTracks()` to resolve the `trackId` carried by clips, entities, and
placement commands. It returns tracks in the project's visual order with `index`,
`label`, `isVisible`, `isMuted`, and `isLocked`. A track that predates typed
tracks reports `type: null`; the host treats those as visual.

A clip snapshot reports everything the write commands can set, so a read-modify-
write round trip is possible without re-deriving host state: `sourceOffsetTicks`
(the in-point) and `sourceDurationTicks` bound a trim, `croppedSourceDurationTicks`
against `durationTicks` reveals a retime, and `isMuted`, `compositeId`,
`maskComposition`, and `rangeMasks` expose the rest of the clip. `maskComposition`
is present only when the clip carries an explicit mask equation; its `expression`
is `null` when the user disabled composed masking, which is distinct from the
field being absent.

Use canonical ticks for all timeline fields. Obtain the time base from
`timeline.ticksPerSecond` and project FPS from `getProject()`.

## React to host changes instead of polling

Every read domain that can change under the user publishes the same pair:
`subscribe(listener)` and `getRevision()`. Listeners are payload-free — pull a
fresh snapshot inside the listener — and are disposed with the extension.

- `timeline` — fires on committed model changes (undo/redo included) and on
  changes to the values `getProject()` reports. Deliberately commit-grained:
  selection and in-progress interactions do not signal.
- `assets` — fires on library changes.
- `selection` — see below.
- `project` — fires on open, close, rename, and every successful save.
- `storage.local` / `storage.project` — fire on this frontend's own writes.
- `ui.catalogues` — fires when any catalogue's contents change, *including*
  options registered by other extensions.
- `ui.commands.subscribeContextKeys` — fires on host context-key changes, for
  extension UI that mirrors host enablement. Prefer a declarative `when` on the
  command itself where that works.

`playback` is the one exception: it publishes `subscribe` without a revision,
because the playhead is continuous and a token would carry no information the
tick does not.

Cache a revision alongside derived state and recompute when it moves. Per-frame
and time-driven work belongs in the render contracts, never in a subscriber.

## Read and set the selection

`selection.get()` returns `{ clipIds, transitionId }`, detached and in host
selection order; clip and transition selection are mutually exclusive. It has its
own `subscribe`/`getRevision` precisely so selecting a clip does not wake timeline
subscribers.

`setClips(clipIds)` replaces the selection — it never adds to it — and
`setTransition(id)` selects one transition, with `null` on either clearing the
selection entirely. Both return a typed result. An unknown ID, or a mask clip
(which the timeline never selects), refuses the *whole* request rather than
applying the valid part, so a stale ID cannot leave you with a plausible-looking
selection you did not ask for. Selection is not undoable and does not persist.

## Drive the transport

`playback` reads the transport: `getTime()` is the playhead in canonical ticks
(continuous while scrubbing), `getFrameTime()` is the frame-aligned tick the
renderer is presenting, and `isPlaying()` is the transport state. Its `subscribe`
is the one signal in the API that is **not** commit-grained — during playback it
fires once per frame, so keep the listener trivial and schedule your own work.

`seek(ticks)`, `play()`, and `pause()` route through the player rather than the
clock, and each returns a typed result:

- the tick is clamped at zero and snapped to the project's frame grid exactly as
  a user's scrub is, so read `getTime()` back instead of assuming the playhead
  landed where you asked;
- `changed: false` is an ordinary answer — seeking inside the current frame, or
  playing while already playing, moves nothing;
- `no_transport` means no player is mounted (the projects page), and
  `transport_busy` means an export is running or a frame/range capture is armed.
  Both are states of a running editor, not errors. `transport_busy` is
  deliberately stricter than what the user can do — the play button and the
  ruler stay live during a capture — because someone who armed the mode can see
  it and move the playhead knowingly, while an extension moving it in the
  background would silently change what gets captured.

A non-finite tick throws, because that is a bug in the caller rather than a state
of the editor.

## Track the open project

`project.get()` returns the open project's `id`, `title`, `createdAt`,
`lastModified`, and `lastSavedAt`, or `null` when none is open. `lastSavedAt`
counts only saves since *this* open: reopening the same project starts null
again. Identity is deliberately path-free: address project-scoped state through
`storage.project`, never the filesystem. `api.timeline.getProject()` is the
neighbouring read for the *render* domain (dimensions, fps, fit mode).

One `project.subscribe` covers `storage.project` becoming available too, but the
two are not the same condition — the storage document hydrates asynchronously,
so a project can be open while `storage.project` is still null. Re-read it
inside the listener instead of caching what it was when the project opened.

`project.onBeforeSave(hook)` runs before the host writes the project document,
which is where you flush in-memory state into `storage.project` so the same save
persists it. It also runs at the head of a project switch, while the outgoing
project's storage is still open — the last moment unwritten state can be saved.
The host awaits the hook, so keep it short: one that throws is reported as a
diagnostic and skipped, and one that overruns the host's budget is abandoned —
a save never hangs on an extension.

## Commit one synchronous transaction

Use `timeline.transaction(label, callback, options?)` for persisted writes. Keep the
callback synchronous and inspect the structured result. Available commands include:

- `createEntity`, `updatePayload`, `moveEntity`, `removeEntity`;
- `createClip`, `moveClip`, `trimClip`, `updateClip`, `splitClip`, `removeClip`;
- `createTrack`, `updateTrack`, `removeTrack`;
- `upsertTransform`, `removeTransform`;
- `createTransition`, `updateTransitionParameters`, `removeTransition`;
- `addClipMask`, `updateMaskParameters`, `setMaskActiveRange`, `removeMask`.

Stage all related commands in one transaction so the host validates ownership and
creates one undo entry. Do not retain the transaction object or call it after the
callback. Raw mutation of the live `timeline.store` is permitted for a trusted,
version-coupled integration, but the extension then owns undo/history, validation,
persistence consistency, cleanup, and missing-extension behaviour.

## Let the host own correctness

Clip and track commands stage *intent*. Overlap resolution, trim limits,
track-class compatibility, and removal cascades are enforced inside the host's
own mutation layer, through the same code a user's drag runs. An extension
cannot author an invalid timeline and cannot opt out, so do not pre-compute
placement defensively — state what you want and read back what happened.

Two behaviours follow, and both are normal:

- A request may be **adjusted**. A placement that clips a neighbour's head or
  tail snaps to that edge; a trim clamps to the media's own bounds, the
  neighbouring clips, and the minimum clip duration. Re-read `listClips()` after
  the commit instead of assuming your requested tick.
- A request may be **refused**, failing the whole transaction with a specific
  code and committing nothing: `asset_not_found`, `track_not_found`,
  `track_type_mismatch`, `track_not_empty`, `no_free_slot`. Landing a clip on
  top of another is refused rather than adjusted — the host blocks that for a
  user drag too, because a correction would be a guess about which side you
  meant.

`createClip` takes a project asset ID and placement only; the host builds the
clip from the asset's media properties and returns its ID. Omit `trackId` to let
the host pick a compatible track, creating one when nothing fits. `moveClip`
slides a clip; `trimClip` changes which part of the source plays; they are
separate commands because they are different edits. `updateClip` sets
non-structural properties — currently `isMuted` — declaratively rather than as a
toggle, so staging a write needs no read first. `splitClip` cuts at a tick
strictly inside the clip and leaves the new right-hand clip for you to find via
`listClips()`. `removeTrack` requires an empty track, so deleting a user's clips
is always something you asked for explicitly.

Extension entities keep their owner check and are not reachable through the clip
commands — use `moveEntity`/`removeEntity`. Mask clips are subordinate and are
likewise rejected; use the mask commands.

Creation supplies common placement and an `ExtensionPayload`; the host generates the
entity ID. Payload updates must remain compatible with the calling extension.
Transition creation targets one of the caller's registered transition contribution
IDs; transition updates/removal are limited to extension-owned transition types.
Mask creation targets host-supported mask types. Bitmap-backed masks use an image
asset ID returned by `assets.ingest`; later mask updates and removal are limited to
the creating extension. For consecutive commits from one interaction (for example
sub-strokes), pass `{ coalesce: { key, phase: "continue" } }`, then use phase `"end"`
on the final commit. Keys are owner-qualified by the host, merged history entries are
bounded, and an intervening edit splits the interaction to preserve undo order.

## Cross media and project domains

Use the host helpers rather than copying editor math:

- `sourceFrameToTicks(frameIndex, sourceFps)` converts source frames;
- `clipProgressToSourceTicks` maps visual clip progress through crop/speed;
- `sourceTicksToClipProgress` performs the inverse mapping;
- `sourcePointToProject` maps source pixels through contain/cover layout into
  centred project coordinates.

Declare the coordinate space, source dimensions, and timebase in AI result schemas.
Keep previews non-mutating; commit only after user confirmation.

## Exchange asset bytes explicitly

Use `assets.list()` and `assets.get()` for detached metadata. Use
`assets.readBlob(assetId)` to read browser/project-backed content. Do not assume the
Python backend can open a browser-selected project path.

Use `assets.ingest({ name, type, blob })` to copy bytes into the active project.
The host validates the input, hash-reuses an existing project asset when possible,
waits for persistence, and always returns a usable asset snapshot. LUT input is
parsed and size-limited before storage. Package and user-wide resources are sources,
not project state: materialize them first, then persist only the returned project
asset ID.

For backend processing, read the blob, upload it through
`backend.uploadArtifact`, and submit the returned artifact ID to a job. Treat
artifacts as temporary exchange objects with host cleanup, not persistent project
assets.
