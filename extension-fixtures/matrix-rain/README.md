# Source-aware Matrix Rain (advanced trusted-filter fixture)

`example.matrix-rain` is the demanding companion to the minimal
[`filter-pack`](../filter-pack) fixture. Where `filter-pack` proves a single
stateless shader, Matrix Rain exists to prove that the **same** public
trusted-filter contract can carry a source-aware, multi-pass, temporal effect —
with no Matrix-specific host loader, registry, renderer hook, or built-in
transformation.

The full design and phase plan lives in
[`docs/source-aware-matrix-rain-filter-extension-plan.md`](../../docs/source-aware-matrix-rain-filter-extension-plan.md).

## What ships today (Phase 4: source-conditioned temporal rain)

- One primary transformation registered through the ordinary `trusted-filter`
  lane. Its persisted identity is `example.matrix-rain/matrix-rain`.
- The **Matrix appearance**, rendered from the injected host Pixi singleton
  (`api.runtime.pixi`) with no bundled copy of Pixi:
  - a fixed grid of 16 original analytic stroke glyphs anchored to the input
    bounds, with smooth derivative-based antialiasing and editable source-space
    glyph size and spacing between rows;
  - deterministic glyph cycling, per-column phase, and speed variation derived
    only from cell coordinates, an explicit seed, and quantized visual time;
  - a five-colour piecewise green palette and coverage-gated low dither;
  - `replaceBlack` and `matrixOnly` output modes.
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
    `advectedPrevious`, `cellGrid`, `proceduralTrail`, `proceduralHead`.
- **Matching GLSL and WGSL programs for both passes** so both the WebGL and
  WebGPU construction paths are covered. Every WGSL uniform struct order mirrors
  its JS uniform order, which mirrors the CPU reference — all kept in lockstep
  (a backend test asserts the JS/WGSL field orders are identical for both
  filters).
- The declared `rendering` metadata is `timeDependency: "history"` with
  `maxHistorySeconds: 6` and `maxStepSeconds: 1/30`.
- A custom authored-parameter validator (exact key set, numeric/integer/color
  fields, enum membership, preserved host spline objects) plus a fail-closed
  `update()` narrowing path.

Later phases add host warm-up scheduling for deterministic seek/export and the
source-composition output modes.

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
Parameter validation is covered separately.

## The generic contract it leans on

Matrix Rain does not get special treatment. It relies only on additions that are
useful to **any** temporal filter author, introduced in SDK `1.6.0`:

- `ExtensionTrustedFilterRenderingDefinition` — declare `none` / `sample` /
  `none` / `sample` / `history` time dependency plus bounded replay/step limits.
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

## Layout

```text
frontend/src/
├── index.ts                        # activate(): registers matrix-rain
└── features/matrixRain/
    ├── MatrixRainFilter.ts         # top-level glyph filter + apply() feedback controller
    ├── MatrixRainStateFilter.ts    # low-res state-update child filter
    ├── constants.ts                # defaults, control groups, rendering policy
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
    │   └── parameterValidation.ts  # validation + fail-closed narrowing
    └── __tests__/                  # math, feedback, lifecycle, filter, validation
```

The feature barrel exports only the factory, definition metadata, defaults, and
public parameter types; shader strings, math, and validation internals stay
private.
