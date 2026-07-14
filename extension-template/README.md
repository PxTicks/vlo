# Minimal vlo extension

This directory is the official SDK 1 starting point for a trusted extension with
both frontend and backend entry points.

## Use the template

1. Copy this directory next to `packages/extension-sdk/`, or replace the local
   `@vlo/extension-sdk` dependency with the published package when one exists.
2. Change the package directory name and `manifest.json` ID together. IDs use
   lowercase letters, numbers, dots, underscores, and hyphens.
3. Run `npm install`, then `npm run build`.
4. Copy the package into `extensions/installed/<manifest-id>/` (or the root set
   by `VLO_EXTENSIONS_ROOT`).
5. Review and approve its exact digest in the extension manager. Backend activation
   occurs after a backend restart; frontend activation occurs on the following page
   load after the matching backend digest reports active.

The build writes immutable browser artifacts to `frontend/dist/`. Do not edit that
directory by hand; rebuild it before approval.

## SDK 1 boundaries

Use this decision ladder: start with scoped contribution and transaction APIs; use
`context.api.trusted.host`, browser APIs, raw registries, or deeper Python imports
when the scoped surface cannot express the feature; promote a repeated raw seam into
a host contract when reuse, portability, or future restricted-mode value warrants
it. The fallback is expected trusted-alpha behaviour, but it is version-coupled.

- `@vlo/extension-sdk` is type-only. Import it with `import type`; runtime access is
  supplied through the host-owned activation context.
- Trusted frontend extensions receive the host's exact Pixi and React singletons as
  `context.api.runtime.pixi` and `context.api.runtime.react`, plus host-curated MUI and
  native panel-control namespaces as `runtime.mui` and `runtime.panelUi`. `panelUi`
  is the complete live barrel, including its raw custom-control registry. Transformation
  factories may create arbitrary Pixi filters, including custom GLSL/WGSL shaders;
  trusted React component slots may use the supplied React runtime. Declarative
  host filters and native notices remain available as simpler, restricted-ready
  alternatives.
- All trusted React surfaces use the same host mount and error boundary. Register
  ordinary content with `context.api.ui.registerComponent(...)` in a declared slot
  such as `transformation-panel.before` or `generation.toolbar`; register larger
  workflows with `registerModal(...)` and open them by local id with `openModal(...)`.
  The host owns dialog placement, escape/close behaviour, lifecycle, and isolation.
- Persistent tools can register a `trusted-workspace` at `right-sidebar` and select
  it with `openWorkspace(localId)`. The workspace mounts lazily on first use and then
  remains mounted while hidden, receiving an `active` prop so animation loops,
  cameras, and AI previews can pause off-screen. This supports arbitrary trusted
  React content such as HTML/SVG/WebGL canvases while the host retains tab placement,
  navigation, error isolation, and teardown.
- Generation tools can inspect the active workflow through
  `context.api.generation.listInputs()`. Put one or more prompt changes in a labelled,
  synchronous `generation.transaction(...)`; the host validates the complete batch
  and applies it as one panel-state update. The API deliberately targets workflow
  inputs rather than ComfyUI DOM nodes.
- Pixi factories return `{ object, update, destroy? }`. The host validates and
  attaches `object`, calls `update` with resolved parameters, detaches it, and owns
  final Pixi destruction. `destroy` is only for additional extension-owned
  resources. This is the parity-safe default; trusted code may use raw
  `renderer.runtime`/stage access when necessary and then owns teardown and export
  parity.
- Host-adapted static parameter presets register through
  `context.api.transformations.presets.register(...)`. API version 1 supports
  partial `ColorGradeFilter` patches: omitted grade fields remain unchanged, while
  animation values and `lutAssetId` are rejected. Use
  `context.api.color.grade.filterName` for the target identity. Registration is
  owner-scoped and rolls back with activation.
- `context.api.entityProviders.register(...)` is the trusted-first custom entity
  path. A provider combines its versioned payload codec with an arbitrary host-Pixi
  `Container`/`Graphics`/`Sprite` factory, optional trusted React inspector, timeline
  presentation, asset lookup, and frame timing. The host flattens that private Pixi
  tree into its ordinary content boundary, so common transformations, filters,
  masks, selection bounds, still capture, and video export remain host-owned and
  identical to built-in content. Use `context.api.timeline.transaction(...)` to
  create and update instances through undoable, owner-checked commands.
  Static providers should implement `getRenderSignature`; identical signatures
  reuse the current GPU texture. The signature must include every provider-owned
  pixel input, including frame time or asset hashes when applicable. Omitting it
  deliberately renders every requested frame, which is the safe default for
  animated or externally mutable objects.
- `context.api.animation` has three deliberately separate trusted-first registries:
  `scalarSources` for arbitrary procedural/random-access scalar mathematics,
  `interpolations` for provider-owned outgoing keyframe segments, and `spatialPaths`
  for independently sampled 2D geometry. Every definition supplies a label,
  versioned validated default data, migration and compile functions, plus optional
  remap/reverse and trusted editor hooks. Spatial paths may also return a trusted Pixi
  overlay through the same `{ object, update, destroy? }` lifecycle used elsewhere;
  the host owns its scene slot and final destruction. Procedural sources used as speed
  factors must explicitly supply a two-way `timeMap`. The host ships no sample curve
  strategy beyond its existing compatibility behaviour.
- `context.renderer` is the full host Pixi renderer, not a restricted facade.
  Mutating it has the same trusted-mode blast radius as using
  `context.api.runtime.pixi`; restricted providers will not receive this object.
- React, React DOM, MUI/emotion, Zustand, and Pixi remain host singletons. The
  template rejects runtime package imports instead of bundling duplicate copies;
  use the injected runtime namespaces. Type-only package imports are erased and are
  permitted for richer editor typings when the package is a development dependency.
- Resolve other live frontend internals through `context.api.trusted.host`. Runtime
  imports from `frontend/src/...` are not canonical: production cannot resolve
  arbitrary source paths, and bundling them may create detached module state.
- That bundle guard prevents common duplicate-singleton mistakes; it is not an
  authority boundary. A
  hand-written build can bypass it, but may then fail at activation or silently load
  incompatible singleton copies. Host-side bundle validation is future work.
- The backend is trusted in-process Python. Keep `create_extension` lightweight;
  defer model loading and long work to a `BackendJobDefinition`. Jobs receive
  extension-scoped uploaded inputs and output-artifact creation, progress,
  cancellation checks, and structured diagnostics. Declare readiness and validate
  both input and output. A job deadline marks ignored work terminal but cannot kill a
  synchronous Python thread; cooperative runners must call
  `context.raise_if_cancelled()` regularly. Keep synchronous readiness and validation
  callbacks lightweight as well; use the job runner for expensive work.
- Trusted frontend code uses `context.api.assets.readBlob(...)` followed by
  `context.api.backend.uploadArtifact(...)`; the backend must not assume it can open
  browser-selected project paths. Prefer the standard `submitJob`/`waitForJob` API.
  `backend.call(...)` remains the owner-bound raw-route escape hatch.
- `context.api.assets.ingest(...)` copies bytes into the active project, waits
  for persistence, and returns the existing or newly created asset on a hash
  match. Use it for generated resources; never persist extension package paths
  in timeline data. LUT-only packages can instead use the declarative look-pack
  format documented in `docs/extension-look-and-filter-packs.md`.
- Tracking-style integrations can use `context.api.timeline.sourceFrameToTicks(...)`
  plus `clipProgressToSourceTicks(...)`/`sourceTicksToClipProgress(...)` to cross a
  clip's crop and speed clock. `sourcePointToProject(...)` maps declared source pixels
  into centred project coordinates. Show a local/non-committing preview first, then
  put all persisted writes in one labelled `timeline.transaction(...)`.
- Backend SDK 1 uses `services.extensions` as its supported compatibility barrel.
  Trusted code may import deeper modules or patch process objects when necessary;
  declare a narrow `vlo` range and restore hooks from `shutdown`, because those
  shapes have no SDK compatibility guarantee.
- Backend staging contains only this package's `backend/` subtree. Put Python
  runtime resources below `backend/`, not in a sibling directory.
- Capability declarations are visible trust metadata, not enforced permissions.

The `/status` backend route is mounted by the host at
`/app/extensions/<extension-id>/api/status`. Remove it when replacing the template
with a real extension contract.
