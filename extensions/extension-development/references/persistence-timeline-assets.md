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
- `storage.local` / `storage.project` — fire on this frontend's own writes.

Cache a revision alongside derived state and recompute when it moves. Per-frame
and time-driven work belongs in the render contracts, never in a subscriber.

## Read the selection and the transport

`selection.get()` returns `{ clipIds, transitionId }`, detached and in host
selection order; clip and transition selection are mutually exclusive. It has its
own `subscribe`/`getRevision` precisely so selecting a clip does not wake timeline
subscribers. SDK 1 does not let an extension *set* the selection: contribute a
command or a menu placement and let the user drive it.

`playback` reads the transport: `getTime()` is the playhead in canonical ticks
(continuous while scrubbing), `getFrameTime()` is the frame-aligned tick the
renderer is presenting, and `isPlaying()` is the transport state. Its `subscribe`
is the one signal in the API that is **not** commit-grained — during playback it
fires once per frame, so keep the listener trivial and schedule your own work.
Seeking and play/pause stay host-owned in SDK 1.

## Commit one synchronous transaction

Use `timeline.transaction(label, callback, options?)` for persisted writes. Keep the
callback synchronous and inspect the structured result. Available commands include:

- `createEntity`;
- `updatePayload`;
- `moveEntity`;
- `removeEntity`;
- `upsertTransform`;
- `removeTransform`;
- `createTransition`;
- `updateTransitionParameters`;
- `removeTransition`;
- `addClipMask`;
- `updateMaskParameters`;
- `setMaskActiveRange`;
- `removeMask`.

Stage all related commands in one transaction so the host validates ownership and
creates one undo entry. Do not retain the transaction object or call it after the
callback. Raw mutation of the live `timeline.store` is permitted for a trusted,
version-coupled integration, but the extension then owns undo/history, validation,
persistence consistency, cleanup, and missing-extension behaviour.

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
