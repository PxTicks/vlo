# Source-aware Matrix Rain (advanced trusted-filter fixture)

`example.matrix-rain` is the demanding companion to the minimal
[`filter-pack`](../filter-pack) fixture. Where `filter-pack` proves a single
stateless shader, Matrix Rain exists to prove that the **same** public
trusted-filter contract can carry a source-aware, multi-pass, temporal effect —
with no Matrix-specific host loader, registry, renderer hook, or built-in
transformation.

The full design and phase plan lives in
[`docs/source-aware-matrix-rain-filter-extension-plan.md`](../../docs/source-aware-matrix-rain-filter-extension-plan.md).

## What ships today (Phase 0 baseline)

- One primary transformation registered through the ordinary `trusted-filter`
  lane. Its persisted identity is `example.matrix-rain/matrix-rain`.
- A single-pass passthrough/debug shader built from the injected host Pixi
  singleton (`api.runtime.pixi`) — no bundled copy of Pixi.
- The declared `rendering` metadata (`timeDependency: "history"`,
  `maxHistorySeconds: 6`, `maxStepSeconds: 1/30`), which reserves the temporal
  contract the later phases implement and exercises the host's rendering-metadata
  validation.
- A custom authored-parameter validator that enforces the exact key set,
  integer/color fields, and continuous-field ranges while preserving
  host-supported animated scalar (spline) values, plus a fail-closed `update()`
  narrowing path.

Later phases add the glyph grid, deterministic cycling, the low-resolution
ping-pong feedback state, edge/motion source injection, WGSL programs, host
warm-up scheduling, and the source-composition output modes.

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

## Layout

```text
frontend/src/
├── index.ts                      # activate(): registers matrix-rain
└── features/matrixRain/
    ├── MatrixRainFilter.ts        # createMatrixRainFilter(pixi) controller
    ├── constants.ts              # defaults, control groups, rendering policy
    ├── types.ts                  # public resolved parameter type
    ├── index.ts                  # feature barrel (factory + metadata only)
    ├── shaders/                  # private GLSL (WGSL added in Phase 2)
    └── utils/                    # parameter validation + color helpers
```

The feature barrel exports only the factory, definition metadata, defaults, and
public parameter types; shader strings and validation internals stay private.
