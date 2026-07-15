# Source-aware Matrix Rain (advanced trusted-filter fixture)

`example.matrix-rain` is the demanding companion to the minimal
[`filter-pack`](../filter-pack) fixture. Where `filter-pack` proves a single
stateless shader, Matrix Rain exists to prove that the **same** public
trusted-filter contract can carry a source-aware, multi-pass, temporal effect —
with no Matrix-specific host loader, registry, renderer hook, or built-in
transformation.

The full design and phase plan lives in
[`docs/source-aware-matrix-rain-filter-extension-plan.md`](../../docs/source-aware-matrix-rain-filter-extension-plan.md).

## What ships today (Phase 2: stateless appearance)

- One primary transformation registered through the ordinary `trusted-filter`
  lane. Its persisted identity is `example.matrix-rain/matrix-rain`.
- The full **stateless Matrix appearance**, rendered from the injected host Pixi
  singleton (`api.runtime.pixi`) with no bundled copy of Pixi:
  - a fixed grid of 16 original analytic stroke glyphs anchored to the input
    bounds, with smooth derivative-based antialiasing and editable source-space
    glyph size and spacing between rows;
  - deterministic glyph cycling, per-column phase, and speed variation derived
    only from cell coordinates, an explicit seed, and quantized visual time;
  - a descending procedural trail with a bright head (no feedback texture yet);
  - a five-colour piecewise green palette and low dither;
  - `replaceBlack` and `matrixOnly` output modes;
  - `cellGrid`, `proceduralTrail`, and `proceduralHead` debug views.
- **Matching GLSL and WGSL programs** so both the WebGL and WebGPU construction
  paths are covered. The WGSL uniform struct order mirrors the JS uniform order,
  which mirrors the CPU reference — all three are kept in lockstep.
- Motion and cycling are a pure function of the render sample's canonical visual
  time (`context.render.visualTimeTicks`), so repeated renders of one logical
  sample are identical and there is no per-frame CPU grid loop or GPU texture
  allocation.
- The declared `rendering` metadata is `timeDependency: "sample"` with
  `maxStepSeconds: 1/30`: the appearance is a pure function of the current
  sample's visual time, with no previous-frame state, so it must not trigger
  history replay. It becomes `history` with a bounded replay window when Phase 3
  adds the feedback texture.
- A custom authored-parameter validator (exact key set, numeric/integer/color
  fields, enum membership, preserved host spline objects) plus a fail-closed
  `update()` narrowing path.

Later phases add the low-resolution ping-pong feedback state, edge/motion source
injection, host warm-up scheduling, and the source-composition output modes.

## Tests

```bash
npm run test --prefix extension-fixtures/matrix-rain
```

The CPU reference in `utils/matrixRainMath.ts` mirrors both shader programs
exactly, so the deterministic hashing, glyph selection, trail/head profile, and
palette are unit-tested without a GPU. Parameter validation is covered
separately.

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
├── index.ts                       # activate(): registers matrix-rain
└── features/matrixRain/
    ├── MatrixRainFilter.ts        # createMatrixRainFilter(pixi, ticksPerSecond)
    ├── constants.ts               # defaults, control groups, rendering policy
    ├── types.ts                   # public resolved parameter + enum types
    ├── index.ts                   # feature barrel (factory + metadata only)
    ├── shaders/
    │   ├── matrixRainGl.ts        # GLSL vertex + fragment
    │   └── matrixRainWgsl.ts      # matching WGSL program
    ├── utils/
    │   ├── matrixRainMath.ts      # deterministic CPU reference (shared masks)
    │   └── parameterValidation.ts # validation + fail-closed narrowing
    └── __tests__/                 # math + validation unit tests
```

The feature barrel exports only the factory, definition metadata, defaults, and
public parameter types; shader strings, math, and validation internals stay
private.
