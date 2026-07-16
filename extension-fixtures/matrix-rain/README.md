# Source-aware Matrix Rain (advanced trusted-filter fixture)

`example.matrix-rain` is the demanding companion to the minimal
[`filter-pack`](../filter-pack) fixture. Where `filter-pack` proves a single
stateless shader, Matrix Rain exists to prove that the **same** public
trusted-filter contract can carry a source-aware, multi-pass, temporal effect —
with no Matrix-specific host loader, registry, renderer hook, or built-in
transformation.

The full design and phase plan lives in
[`docs/source-aware-matrix-rain-filter-extension-plan.md`](../../docs/source-aware-matrix-rain-filter-extension-plan.md).

## What ships today (finished Phase 6 example)

- One primary transformation registered through the ordinary `trusted-filter`
  lane. Its persisted identity is `example.matrix-rain/matrix-rain`.
- The **Matrix appearance**, rendered from the injected host Pixi singleton
  (`api.runtime.pixi`) with no bundled copy of Pixi:
  - a fixed grid of 24 original analytic stroke glyphs anchored to the input
    bounds, with smooth derivative-based antialiasing and editable source-space
    glyph size and spacing between rows;
  - deterministic glyph cycling, per-column phase, and speed variation derived
    only from cell coordinates, an explicit seed, and quantized visual time;
  - a five-colour piecewise green palette and coverage-gated low dither;
  - four premultiplied-alpha output modes: opaque `replaceBlack`, transparent
    `matrixOnly`, additive `overlaySource`, and source-alpha-constrained
    `sourceTinted`.
- **Two-pass temporal feedback.** The top-level glyph filter overrides Pixi's
  `apply()` to drive a low-resolution state-update child filter over two
  persistent RGBA8 ping-pong textures. Each new logical sample advances the
  feedback once — frame-rate-independent half-life decay, downward
  fractional-cell advection, and source-luma injection gated by the procedural
  trail — while repeated/paused samples re-render from the current state without
  advancing it. The state's B channel carries the current source signal, so a
  newly visible or static shape stays legible immediately through the direct
  current-shape term, before the rain history develops.
  - state lifecycle: the ping-pong textures reallocate on input resize and reset
    on any grid-topology change (glyph size / spacing) or timeline discontinuity.
- **Edge- and motion-aware source injection.** The state pass reads the source
  through a selectable `signalMode` — `luma`, `inverseLuma`, `alpha`, `edge`,
  `lumaEdge`, `alphaEdge` — with four-neighbour colour/alpha edge detection and
  threshold/gain/gamma shaping, so opaque and transparent, bright and dark, and
  fine-line-art silhouettes all register. It compares the shaped signal with the
  previous signal at the same cell to derive **motion** (`absolute` or
  `brightening`), which injects new bright activity — optionally bypassing the
  procedural-trail gate via `motionImmediateAmount` — and is stored in the state
  A channel. The glyph body then combines rain + direct-shape (B) + direct-motion
  (A), and source/motion boost the pale head. Injection combines with the trail
  via an overall `injectionStrength` and selectable `accumulationMode`
  (`softAdd` / `max` / `add`).
  - **Source-emitted streams.** Each procedural column/pulse is only a candidate:
    a stable GPU hash accepts it according to an `ambientSpawn` floor plus the
    current source/motion drive. Accepted heads are stored as vitality in state
    G and advected with the rain, so the bright descending layer originates in
    source features instead of being composited independently. Analytic crossing
    detection prevents narrow heads being skipped between history samples.
    `darkDamping`
    applies continuous frame-rate-independent attenuation in unsupported cells;
    lowering Ambient Spawn to zero makes the rain fully source-bound.
  - debug views: `currentSignal`, `motion`, `injection`, plus `rainState`,
    `advectedPrevious`, `cellGrid`, `proceduralTrail`, `proceduralHead` remain
    available internally for shader development rather than occupying the
    normal creative interface.
- **Compact creative controls.** The panel exposes thirteen intent-level values:
  Brightness, Contrast, Head Brightness, Speed, Glyph Size, Spawn Rate, Trail
  Density, Vertical Spacing, source Mode, Source Coupling, Ambient Spawn, Tint,
  and Output.
  Head Brightness sets the glowing heads relative to the body while overall
  Brightness scales both. Trail Density resolves half-life/shape/head width;
  Source Coupling resolves source/motion influence and dark damping, while
  Ambient Spawn independently controls source-free streams. Tint derives the
  full palette.
  Spawn Rate changes both pulse spacing and the probability that a candidate
  pulse becomes an active stream, so its visual range remains pronounced even
  when broad procedural trails would otherwise have similar average coverage.
  Detailed Phase 4 values remain validated defaults for project compatibility
  but are no longer presented as independent sliders.
- **Matching GLSL and WGSL programs for both passes** so both the WebGL and
  WebGPU construction paths are covered. Every WGSL uniform struct order mirrors
  its JS uniform order, which mirrors the CPU reference — all kept in lockstep
  (a backend test asserts the JS/WGSL field orders are identical for both
  filters).
- The declared `rendering` metadata is `timeDependency: "history"` with
  `maxHistorySeconds: 6` and `maxStepSeconds: 1/30`.
- The native host discovers those requirements, carries stable sample/sequence
  identity, bridges dropped playback samples, and performs bounded hidden GPU
  warm-up for seek, mid-clip export, and still capture. The extension contains
  no private seek detector or export renderer.
- A custom authored-parameter validator (exact key set, numeric/integer/color
  fields, enum membership, preserved host spline objects) plus a fail-closed
  `update()` narrowing path.

> Note: the GPU multi-pass orchestration (the `apply()` override, ping-pong
> textures, and both fragment programs) is verified structurally here — CPU
> reference parity, program construction through the real Pixi factory, and
> controller-level advance/reset/dispose behaviour. On-device WebGL/WebGPU
> rendering is validated separately in the GPU visual suite.

## Tests

```bash
npm run test --prefix extension-fixtures/matrix-rain
```

The CPU reference in `utils/matrixRainMath.ts` mirrors every shader program
exactly, so the deterministic hashing, glyph selection, trail/head profile,
palette, and the feedback math (source-conditioned spawning, head vitality,
dark damping, half-life retention, soft-add, luma, and advection) are unit-tested
without a GPU. `utils/feedbackLifecycle.ts` covers the
reallocation/reset rules, and `MatrixRainFilter.test.ts` covers the multi-pass
controller (advance-once-per-sample, resize reset, exact-once dispose).
Parameter validation is covered separately. CPU visual signatures pin
representative circle, transparent-silhouette, line-art, low-contrast, and
moving-feature cases; shader contract tests keep GLSL/WGSL composition aligned.

## Creative recipes

These are starting points, not separate effects. `MATRIX_RAIN_RECIPES` contains
the same values as executable data; merge a recipe over the shipped defaults.

| Recipe | Key settings | Use |
|---|---|---|
| Classic Matrix | Defaults | Balanced replacement with visible source structure |
| Source-bound Edges | Mode `edge`, Source Coupling `1`, Ambient Spawn `0`, Trail Density `0.42` | Rain emitted almost entirely from detected edges |
| Ghost Overlay | Output `overlaySource`, Tint `#20d9c2`, Brightness `0.7` | Preserve the source while adding restrained cyan rain |
| Bloom Heads | Output `matrixOnly`, Head Brightness `3`, Brightness `0.8`, Contrast `1.25` | Transparent glyph layer prepared for Bloom |

### Matrix followed by Bloom

Filter order is significant. Add **Matrix Rain first**, then add the native
**Bloom** filter after it with Strength `2.5` and Quality `4`. Matrix emits the
structured glyph/head image; Bloom consumes that result. Keeping Matrix head
brightness above body brightness makes Bloom emphasize tips without turning the
entire trail into an undifferentiated glow. When the original source must remain
visible, use `overlaySource` instead of `matrixOnly` and lower Bloom Strength.

## Performance instrumentation

`estimateMatrixRainWorkload()` reports the full-resolution pixel count,
cell-resolution state dimensions, ping-pong RGBA8 bytes, and maximum warm-up
sample count without iterating over cells. The fixture tests cover 720p, 1080p,
and 4K examples at representative glyph sizes. With the shipped 10 px glyph and
2 px row spacing, 1080p uses 17,280 state texels (0.83% of full resolution) and
138,240 bytes for both state textures. A six-second, 30 Hz history declaration
has a maximum 180-sample cold pre-roll; ordinary dropped frames are bridged from
valid state rather than replaying that whole window. Bloom cost is separate and
depends on its own quality setting.

## The generic contract it leans on

Matrix Rain does not get special treatment. It relies only on additions that are
useful to **any** temporal filter author, introduced in SDK `1.6.0`:

- `ExtensionTrustedFilterRenderingDefinition` — declare `none` / `sample` /
  `history` time dependency plus bounded replay/step limits.
- `ExtensionFilterRenderSample` on `ExtensionTrustedFilterApplyContext` —
  immutable render-sample identity (sequence/sample IDs, mode, continuity,
  presentation/visual/source ticks, delta, warm-up flag) so a filter can tell
  sequential frames from repeated paused renders, seeks, stills, and exports
  without reading any global clock.
- Transform-ID-keyed instance reuse — two authored transforms from one
  contribution never exchange their (possibly temporal) filter instances.

An extension that omits `rendering` and ignores the extra context fields keeps
its existing stateless behavior unchanged.

## Build

```bash
npm run build --prefix extension-fixtures/matrix-rain
```

The build type-checks against the local `@vlo/extension-sdk` and emits
`frontend/dist/index.js`. Use `type`-only Pixi imports for authoring and the
injected runtime for every runtime constructor so the bundle never contains a
second copy of Pixi.

For live UI testing, keep this fixture as the canonical source, build it, then
copy the distributable `manifest.json`, `README.md`, and `frontend/dist/` into
`extensions/installed/example.matrix-rain/`. Rescan/approve the changed digest
and refresh the page. Never edit the installed bundle by hand.

## Layout

```text
frontend/src/
├── index.ts                        # activate(): registers matrix-rain
└── features/matrixRain/
    ├── MatrixRainFilter.ts         # top-level glyph filter + apply() feedback controller
    ├── MatrixRainStateFilter.ts    # low-res state-update child filter
    ├── constants.ts                # defaults, control groups, rendering policy
    ├── recipes.ts                  # documented creative presets + Bloom stack
    ├── types.ts                    # public resolved parameter + enum types
    ├── index.ts                    # feature barrel (factory + metadata only)
    ├── shaders/
    │   ├── matrixRainGl.ts         # GLSL glyph program (reads state)
    │   ├── matrixRainWgsl.ts       # matching WGSL glyph program
    │   ├── matrixRainStateGl.ts    # GLSL state-update program
    │   └── matrixRainStateWgsl.ts  # matching WGSL state-update program
    ├── utils/
    │   ├── matrixRainMath.ts       # deterministic CPU reference (+ feedback math)
    │   ├── feedbackLifecycle.ts    # state reallocation / reset predicates
    │   ├── performance.ts          # static workload / warm-up instrumentation
    │   └── parameterValidation.ts  # validation + fail-closed narrowing
    └── __tests__/                  # math, feedback, lifecycle, filter, validation
```

The feature barrel exports only the factory, definition metadata, defaults,
recipes, workload estimator, and public parameter types; shader strings, render
math, and validation internals stay private.
