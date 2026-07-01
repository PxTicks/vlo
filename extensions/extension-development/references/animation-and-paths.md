# Scalar animation and spatial paths

Use this reference for `context.api.animation.scalarSources`,
`context.api.animation.interpolations`, and `context.api.animation.spatialPaths`.
Keep these three contribution families distinct.

## Choose the correct abstraction

- Register a **scalar source** for arbitrary random-access mathematics that need not
  expose keyframes: expressions, procedural functions, sampled data, or deterministic
  simulations.
- Register an **interpolation** for provider-owned mathematics on an outgoing
  segment of host-structured keyframes. The compiler receives the complete track and
  segment index, allowing neighbourhood-dependent strategies.
- Register a **spatial path** for independently sampled 2D geometry. Use its scalar
  `timing` value to control traversal rather than mixing path geometry with scalar
  interpolation.

Do not add Bezier-specific handles or another strategy union to core. Store provider
data in versioned `ExtensionPayload` envelopes.

## Validate, migrate, and compile

For every registration, define ID, label, API version, schema version, validated
default JSON, `validate`, optional `migrate`, and synchronous `compile`.

Return disposable compiled evaluators. Keep `sample`/`pointAt` deterministic,
random-access, synchronous, and inexpensive. Precompute coefficients in `compile`;
never parse data or perform I/O per sample.

Scalar sources may expose `derivative`. Spatial paths may expose tangent, bounds,
length, distance sampling, and hit testing when they can do so accurately.

## Declare edit capabilities explicitly

Provide scalar/interpolation `remap` when persisted data supports reversal, retiming,
or affine value changes. Provide path `reverse` when geometry can reverse. Omit these
hooks to make unsupported host edits fail closed rather than corrupt opaque data.

If a procedural scalar is valid as a speed factor, return a two-way `timeMap` with
`outputToInput` and `inputToOutput`. Do not assume every scalar function is an
invertible time warp.

## Add trusted editors and overlays

Use optional React editors for provider-owned data. Call `onChange` with a complete
new parameter; let the host manage preview/undo sessions. Honour the supplied domain
bounds instead of assuming normalised time or value ranges.

Use `createOverlay` for path handles or visualisation. Return the same trusted Pixi
object lifecycle used by filters and entities. Let the host own viewport placement,
attachment, and final destruction.

## Protect hot paths

Avoid JSON serialization, allocation, registry lookup, or compilation on every
sample. Ensure cache keys change whenever provider data changes and dispose evicted
compiled values. Exercise endpoints, extrapolation, cache invalidation, migration,
reversal/remap, speed integration/inversion, path bounds, and overlay teardown.
