# Rendering, entities, and transformations

Use this reference for trusted Pixi rendering, transformations, custom entities,
transitions, and preview/export parity.

## Reuse the trusted Pixi lifecycle

Return `ExtensionTrustedPixiObjectInstance` from Pixi factories:

- `object`: an object created from the injected host Pixi runtime;
- `update(parameters, context)`: synchronous provider-owned updates;
- `destroy?()`: cleanup for extra extension resources only.

Let the host validate, attach, detach, composite, and finally destroy `object`.
This managed path is the parity-safe default. When it cannot express the behaviour,
a trusted extension may resolve `renderer.runtime`, attach to the live stage, or
patch renderer internals. Such raw work must clean up, re-resolve mount-scoped
references, and verify live, still, and export behaviour itself. Never lease one
managed Pixi object to two host slots.

## Register transformations

Register definitions through `context.api.transformations.register`.

Choose the least restrictive contract that matches the behaviour:

- Use `trusted-filter` as the primary custom filter/shader path. Construct any host
  Pixi `Filter`, including custom GLSL/WGSL, through `runtime.pixi`.
- Use `trusted-transformation` for arbitrary synchronous changes to the documented
  render state rather than a filter object.
- Use `host-filter` only as a declarative convenience over the bounded host list.
  Do not widen that list to simulate trusted extensibility.

Define a stable local ID (the host owner-qualifies it), label, API version,
compatible control groups, defaults, and parameter validation. Use native
number/slider, checkbox, text/colour, and select controls where suitable. Mark
adjustment compatibility deliberately.

Expect the host to resolve animated parameters and reuse trusted filter instances.
Isolate extension-owned resources in `destroy`; do not destroy the host filter
object yourself.

## Contribute parameter presets

Register a host-panel preset through
`context.api.transformations.presets.register`. The host owner-qualifies its stable
local ID, validates it during activation, removes it on rollback or deactivation,
and applies it through the target panel's ordinary undoable commit path.

Preset support is host-adapted rather than automatic for every transformation. In
API version 1 the only target is the `ColorGradeFilter` identity exposed as
`context.api.color.grade.filterName`. Its `parameters` are a static partial patch:
omitted fields keep their authored values, recognized fields are clamped, and
animation objects, synthetic UI keys, `colorModel`, and `lutAssetId` are rejected.
LUT-backed preset contributions are not supported in API version 1; do not put
package paths or guessed project asset IDs in a grade preset.

## Register rendered entities

Use `context.api.entityProviders.register` for a new timeline content type. Define:

- the complete payload provider contract;
- `kind: "trusted-pixi"`, label, and optional timeline colour;
- validated `defaultPayload`;
- `createRenderable` returning the shared Pixi lifecycle instance;
- optional `getRenderSignature`;
- optional trusted React inspector.

Return a host-Pixi `Container` subclass such as `Container`, `Graphics`, or `Sprite`.
Build the private content tree inside it. Let core apply common transforms, masks,
visibility, blend behaviour, bounds composition, and capture/export routing.

Use inspector `updateData` for one owner-checked undoable payload update. Do not
reach into the timeline store from inspector controls.

## Register transitions

Use `context.api.transitions.register` for first-class timeline transitions. Define
a stable local ID, label, glyph, schema version, optional native controls/defaults,
optional static z-order preference, and a deterministic `renderFrame` callback.

`renderFrame` receives validated JSON parameters, normalized progress, detached
outgoing/incoming clip snapshots, timing, project dimensions, and FPS. Return
transient outgoing/incoming transforms and optional color layers. To use custom
shader effects, register a trusted filter transformation and return a `filter`
transform whose `filterName` is that registration ID. Keep callbacks synchronous
and side-effect free; the same resolver feeds live preview and export.

Transition parameter migrations are currently applied at render time only; they
do not rewrite the persisted project transition immediately and panel/API edits
still validate against the stored schema version. Keep migration functions
deterministic and compatible with old saved data until the host adds a
project-level transition upgrade pass.

## Cache only truly static pixels

Implement `getRenderSignature` when identical calls produce identical pixels. Include
every provider-owned input beyond host-keyed payload/entity/output state: relevant
frame time, external state, and asset hashes. Omit the callback for animated or
externally mutable content; the safe fallback renders each requested frame.

Treat `context.renderer` as the full trusted host renderer. Use that authority only
when required and document the resulting compatibility coupling.

## Verify rendering parity

Exercise the same provider through live preview, still capture, and video export.
Also cover transformation application, masks, selection/bounds, provider switching,
registration disposal, update failures, and final cleanup. Test at project/export
resolution rather than assuming a fixed 1x raster.
