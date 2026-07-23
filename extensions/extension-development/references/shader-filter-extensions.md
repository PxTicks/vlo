# Shader filter extensions

Use this reference only to create, adapt, debug, or verify a custom shader that
ships as a trusted Vlo extension. Keep the effect implementation inside the
extension package. Do not add a native transformation, built-in filter, host
renderer branch, adapter special case, or effect-specific SDK surface as part of
this workflow.

## Contents

- [Clarify the effect](#clarify-the-effect)
- [Inspect the extension contract](#inspect-the-extension-contract)
- [Stay within the extension lane](#stay-within-the-extension-lane)
- [Keep one canonical package](#keep-one-canonical-package)
- [Register a trusted filter](#register-a-trusted-filter)
- [Use the injected Pixi runtime](#use-the-injected-pixi-runtime)
- [Define parameters once](#define-parameters-once)
- [Build matching shader programs](#build-matching-shader-programs)
- [Update live uniforms](#update-live-uniforms)
- [Choose coordinate spaces](#choose-coordinate-spaces)
- [Preserve premultiplied alpha](#preserve-premultiplied-alpha)
- [Declare time and history](#declare-time-and-history)
- [Use host-provided animation and masking](#use-host-provided-animation-and-masking)
- [Diagnose black output](#diagnose-black-output)
- [Diagnose inert controls](#diagnose-inert-controls)
- [Test in layers](#test-in-layers)
- [Package and test in the live app](#package-and-test-in-the-live-app)
- [Definition of done](#definition-of-done)

## Clarify the effect

Establish a concrete visual and behavioural target before choosing the shader
architecture.

1. Ask for an existing implementation, shader, repository, paper, video, or
   still-image reference if the user has not supplied one. Prefer source code
   that reveals the algorithm over an image that shows only the result.
2. Ask one concise follow-up at a time when an unresolved choice would
   materially change the implementation.
3. Confirm:
   - whether the effect replaces, overlays, or transforms its input;
   - which controls must be editable or keyframeable;
   - whether animation is a random-access function of time or depends on earlier
     frames;
   - whether glyphs, noise, lookup textures, models, or other package assets are
     required;
   - whether the effect must work on clips, adjustment clips, effect masks,
     preview, still capture, and export;
   - the expected behaviour under clip scale, crop, movement, and project resize.
4. If the user explicitly wants exploratory design without a reference, state
   the visual assumptions before implementing them.

Do not translate a reference implementation line by line before identifying its
state model, coordinate spaces, compositing convention, and timing source.

## Inspect the extension contract

Read current repository sources instead of relying on remembered APIs:

- `packages/extension-sdk/src/index.ts` for public extension types;
- `extension-template/` for the supported package and build shape;
- `extension-fixtures/filter-pack/` for minimal filter registration;
- `extension-fixtures/matrix-rain/` for source-, sample-, history-, and
  shader-aware patterns;
- this skill's [rendering reference](rendering-entities-transformations.md),
  [lifecycle reference](trusted-lifecycle.md), and
  [packaging reference](packaging-and-testing.md).

Use `rg` to find current definitions and exercised tests. Treat plans in `docs/`
as design context, not stronger evidence than the public SDK and executable
fixtures.

Read host or adapter code only when necessary to understand or report a contract
failure. Do not turn that investigation into a native implementation change
under this extension-authoring workflow.

## Stay within the extension lane

Register arbitrary Pixi filters and custom GLSL/WGSL programs as
`kind: "trusted-filter"` contributions. Use the capabilities already projected
through `@vlo/extension-sdk` and the injected runtime.

Never implement the requested effect through:

- a native catalogue entry or built-in filter class;
- a Vlo frontend feature or renderer service;
- an extension-specific loader, mask path, clock, cache, or render branch;
- a private fork of host keyframes, masking, preview, still, or export logic;
- a new SDK or adapter capability added only to make this one effect work.

If the public trusted-extension contract cannot express a required behaviour,
isolate the smallest missing generic capability and report it to the user. Stop
before changing host, adapter, SDK, or native-channel code unless the user
separately authorises that broader repository work. Keep any proposed host
capability generic and independent of the effect, but do not implement it while
following this reference.

Do not use `host-filter` for new shader code. That kind only selects an existing
bounded host filter and does not package a custom shader.

## Keep one canonical package

Develop one buildable extension package containing source, focused tests,
manifest, and generated frontend bundle. Start from `extension-template/` for an
installable project. Use an `extension-fixtures/` package as the canonical source
only when the effect is intentionally also a repository conformance example.

Copy only distributable bytes into
`extensions/installed/<extension-id>/` for live testing.

Remember:

- fixture packages are not automatically loaded by the live app;
- installed extension bytes must be scanned and approved by exact digest;
- frontend activation requires a page refresh after approval;
- generate `frontend/dist/` through the build; never edit it by hand;
- never let installed and source copies evolve independently;
- increment the extension version when publishing a changed package.

## Register a trusted filter

Register owner-local contributions inside `activate(context)`:

```ts
context.api.transformations.register({
  id: "my-effect",
  apiVersion: 1,
  kind: "trusted-filter",
  label: "My Effect",
  adjustmentCompatible: true,
  groups: CONTROL_GROUPS,
  defaultParameters: DEFAULT_PARAMETERS,
  validateParameters,
  rendering: { timeDependency: "none" },
  createFilter: () => createMyFilter(context.api.runtime.pixi),
});
```

Let the host owner-qualify the contribution ID, persist authored transforms,
resolve supported keyframes, bind filter instances by transform ID, apply masks,
route preview/export, and destroy the returned Pixi filter.

Set `adjustmentCompatible: true` only when the effect correctly consumes a group
input. Test that path before claiming compatibility.

## Use the injected Pixi runtime

Construct every runtime object with `context.api.runtime.pixi`. Import SDK and
Pixi types with `import type`. Do not bundle or runtime-import another Pixi copy;
objects from it can fail host slot validation or carry detached global state.

Return the managed lifecycle shape:

```ts
{
  object,
  update(parameters, context) {
    // Update this authored transform's retained extension instance.
  },
  destroy() {
    // Release extension-owned auxiliary resources only.
  },
}
```

The host owns attachment, detachment, and final destruction of `object`. Destroy
only textures, buffers, render targets, subscriptions, workers, or child filters
created and owned by the extension.

## Define parameters once

Keep control keys, defaults, authored validation, resolved parameter types, and
shader uniform names visibly aligned.

- Give every declared control a finite JSON default.
- Reject unknown, missing, malformed, non-finite, and out-of-range persisted
  values; do not silently repair invalid project data in the render path.
- Mark only continuous, random-access aesthetic values with
  `supportsSpline: true`.
- Keep seeds, enums, colours, resource identities, and topology-changing values
  static unless their animated behaviour is explicitly designed.
- Accept host spline objects in authored validation for spline-enabled fields.
- Require resolved numbers in `update`; the host resolves supported scalar
  animation before filter dispatch.
- Fail closed on invalid resolved parameters and preserve the last good GPU
  state.

The registry expects every declared control parameter to exist. Adding a control
to a released extension can invalidate old authored transforms unless the
extension provides a compatible migration or default-materialisation strategy.
Treat parameter schema changes as compatibility changes.

Expose intent-level controls with visibly independent effects. Ensure a size
control changes real geometric detail; scaling a coarse bitmap only magnifies
pixelation.

## Build matching shader programs

Provide matching GLSL and WGSL programs so renderer selection does not change
availability or behaviour.

For GLSL ES 3 programs using `in`/`out`, unsigned integers, bitwise operations,
or array constructors, put this before every other token:

```glsl
#version 300 es
```

Use Pixi filter vertex conventions. Keep vertex varyings, fragment inputs,
global uniforms, resource names, sampler names, and entry points exact.
Initialize every fragment path, including debug and transparent-output branches.

For WGSL:

- match uniform struct field order to JavaScript resource insertion order;
- match bind groups, bindings, resource names, and entry points exactly;
- respect uniform-buffer alignment for vectors and matrices;
- mirror hash, coordinate, alpha, and branch semantics from GLSL;
- construct the program through the real injected Pixi `GpuProgram` in a smoke
  test.

Share generated constants between programs where practical. Keep CPU references
for deterministic hashing, grid mapping, interpolation, feedback, and other
testable maths.

## Update live uniforms

Pixi copies primitive descriptor values while creating a `UniformGroup`. The
descriptor object passed to `Filter.from` is not necessarily the live GPU-facing
object.

Create the filter, then retain its live resource:

```ts
const descriptors = {
  uAmount: { value: 1, type: "f32" as const },
  uTint: {
    value: new Float32Array([1, 1, 1]),
    type: "vec3<f32>" as const,
  },
};

const object = pixi.Filter.from({
  gl: { name: "my-effect", vertex: VERTEX, fragment: FRAGMENT },
  gpu: {
    vertex: { source: WGSL, entryPoint: "mainVertex" },
    fragment: { source: WGSL, entryPoint: "mainFragment" },
  },
  resources: { effectUniforms: descriptors },
});

const uniforms = object.resources.effectUniforms.uniforms;

return {
  object,
  update(parameters) {
    uniforms.uAmount = Number(parameters.amount);
    uniforms.uTint[0] = Number(parameters.red);
  },
};
```

Do not update `descriptors.uAmount.value` after construction and assume the GPU
sees it. Array-backed colours can appear to update because their references are
shared while scalar sliders remain frozen; treat that asymmetry as evidence that
the wrong uniform object is being mutated.

## Choose coordinate spaces

Document the space used by every spatial value:

- texture/filter-frame pixels;
- source-local content pixels;
- project/output pixels;
- normalized UV coordinates;
- glyph/grid cells.

Pixi filter frames can change as a transformed clip moves, scales, or extends
outside the viewport. A source-anchored grid should use `context.contentSize`
and convert filter-frame coordinates back to source-local coordinates. Consider
`clipToViewport: false` when viewport clipping would move the origin or resize
the filter frame.

Test at least two clip scales, partial offscreen placement, non-square media,
project resize, preview/export resolution, and masked/unmasked paths. Derive and
test coordinate mappings; do not hide drift with unexplained offsets.

## Preserve premultiplied alpha

Pixi filter textures use premultiplied alpha. When manipulating straight colour:

1. safely unpremultiply sampled input when alpha is non-zero;
2. perform the colour operation;
3. premultiply output RGB by output alpha.

For transparent effect-only output, no RGB channel may exceed alpha. Verify that
zero coverage produces transparent black and opaque replacement writes alpha
`1`.

Define composition modes and test each with opaque, translucent, and zero-alpha
sources. Useful premultiplied patterns are:

- effect-only: `rgb = straightEffect * coverage`, `a = coverage`;
- source overlay: combine premultiplied source and effect, then enforce
  `rgb <= outputAlpha`;
- source-constrained tint: multiply effect coverage by source alpha;
- opaque replacement: blend against the authored background and write `a = 1`.

Clamp or discard sampled RGB when source alpha is zero. Never leak hidden colour
from transparent source texels.

## Declare time and history

Choose the honest rendering dependency:

- `none`: a pure function of input and parameters;
- `sample`: reads the current canonical timeline sample but retains no previous
  frame state;
- `history`: retains feedback state and needs continuity-aware replay/reset.

For sample animation, derive time from `context.render.visualTimeTicks` and the
host timeline tick rate. Never use wall-clock time, `performance.now()`, or an
independent ticker. Repeated rendering of one logical sample must be identical.

For history filters:

- bind retained state to the host-created instance for one authored transform;
- advance only on certified sequential samples;
- do not advance on `repeat`;
- reset or accept host warm-up on sequence changes and discontinuities;
- honour warm-up samples without presenting them;
- declare bounded history and maximum step metadata;
- allocate ping-pong textures on topology changes, not every frame;
- never sample from the texture currently being written;
- release every auxiliary GPU resource from `destroy`.

A fragment invocation cannot reliably preserve previous-frame state by itself.
Store history in explicit extension-owned textures or buffers managed by the
filter instance and drive it from the host's public sample/continuity context.

## Use host-provided animation and masking

Expose ordinary declarative controls and return an ordinary host-Pixi filter.
The existing extension adapter then gives the contribution the host's parameter
keyframes, clip masks, effect masks, adjustment clips, still capture, and export
routing.

Do not implement a private mask system, extension-only keyframe format, or
alternate preview/export route. If one of these capabilities fails only for the
extension, reproduce the failure against the public contract and report it as a
host/adapter issue. Do not patch the native channel while following this
extension-only reference.

For sample/history filters, verify that masked rendering receives the same
sample and continuity context as the unmasked route. Test deliberate filter
stack order. Put structure-producing shaders before native post-effects such as
Bloom, and tune isolated highlights above body brightness so glow preserves
glyph or edge structure.

## Diagnose black output

Check these in order:

1. Confirm the intended extension digest is approved, activated, and loaded
   after refresh.
2. Check browser diagnostics for activation, GLSL compilation, WGSL validation,
   and update failures.
3. Confirm the filter uses the injected host Pixi runtime.
4. Confirm GLSL version, entry points, varyings, resources, bind groups, and
   WGSL uniform order.
5. Render a constant diagnostic colour before debugging the visual algorithm.
6. Confirm every fragment path writes finite premultiplied output.
7. Confirm texture coordinates and content/frame sizes are positive and in the
   expected space.
8. Confirm authored validation accepts the complete parameter bag; rejected
   transforms are skipped.
9. Confirm `update` receives resolved values and does not reject a valid enum,
   keyframe, or default.
10. Temporarily disable masks and neighbouring filters to isolate stack effects.

Keep a passthrough or constant-colour debug mode until program construction and
coordinates are proven.

## Diagnose inert controls

Check these in order:

1. Ensure only one copy of the effect is present, or edit the topmost visible
   copy. A later opaque filter can conceal valid changes underneath.
2. Confirm the selected panel belongs to the visible authored transform.
3. Confirm each control name equals its persisted parameter key and reaches
   `update`.
4. Confirm live-preview and committed values pass authored validation.
5. Confirm spline-enabled values are resolved before GPU update.
6. Mutate `object.resources.<group>.uniforms`, not the descriptors used at
   construction.
7. Assert the exact live scalar uniform changes in a focused unit test.
8. Confirm the shader reads the uniform and has not optimized it away.
9. Test an extreme value with an unmistakable result before tuning a subtle
   range.
10. Rebuild, synchronize, approve the new digest, and refresh.

If colours update but numeric sliders do not, suspect copied scalar uniform
descriptors first.

## Test in layers

Add proportionate tests while implementing.

### Pure contract tests

- defaults pass authored validation;
- unknown, missing, non-finite, out-of-range, and malformed values fail;
- spline objects are accepted only for spline-enabled authored controls;
- resolved narrowing rejects remaining spline objects;
- deterministic hashes and time buckets repeat exactly;
- coordinate/grid mappings cover boundaries and topology changes.

### Shader contract tests

- required GLSL version is the first directive;
- GLSL and WGSL declare matching custom uniforms;
- WGSL field order matches resource insertion order;
- source-local coordinate conversion appears in both programs;
- every composition/debug branch writes a valid result.

### Runtime tests

- use a Pixi mock that copies primitive descriptors into a separate live uniform
  map;
- assert `update` changes live scalar, vector, enum, time, and content-size
  uniforms;
- assert invalid resolved parameters preserve the last good state;
- assert two authored transforms never share instances or history;
- assert teardown releases extension-owned resources exactly once.

### Package and integration tests

- typecheck and build the extension package;
- activate its built bundle through a mock extension host;
- construct WGSL with the real injected Pixi `GpuProgram`;
- exercise the transformation registry and filter applicator without adding a
  bespoke host route;
- cover paused preview and committed parameter updates;
- compare normal, effect-masked, adjustment, still, and export paths;
- test repeat, play, scrub, seek, resize, removal, and re-add for temporal
  filters.

### Live visual smoke test

1. Apply exactly one copy of the extension filter.
2. Verify passthrough or constant-colour output.
3. Exercise every control at minimum and maximum.
4. Toggle every output and development debug mode.
5. Play, pause, scrub both directions, and seek.
6. Scale and move the clip.
7. Add a clip mask and an effect mask.
8. Test an adjustment clip when declared compatible.
9. Compare preview with still and export output.
10. Remove and re-add the effect, reload the project, and verify persistence.

## Package and test in the live app

Use the commands relevant to the extension package:

```bash
npm test --prefix extension-fixtures/<package>
npm run typecheck --prefix extension-fixtures/<package>
npm run build --prefix extension-fixtures/<package>
backend/.venv/bin/python -m pytest backend/tests/test_extension_template.py -k <package>
npm run check:extension-surface
```

For a standalone package, run its equivalent local test, typecheck, and build
commands. If the documented Python interpreter is unavailable, use the
repository virtualenv's available interpreter and report the substitution.

Copy the built distributable into `extensions/installed/<extension-id>/`, scan
it, approve its exact digest, and refresh before UI testing. Review every
extension-surface category reported for a conformance fixture. A clean catalogue
does not replace behavioural tests.

If testing exposes a host or adapter defect, capture a minimal reproduction and
report the blocked capability. Do not silently broaden this extension task into
native implementation work.

## Definition of done

Finish only when:

- the visual target and assumptions are documented;
- all effect code lives in the extension package or its conformance fixture;
- the extension registers through the ordinary `trusted-filter` contract;
- no native filter, renderer, adapter, or effect-specific host branch was added;
- controls update live, keyframe where declared, and persist correctly;
- scaling changes real detail rather than magnifying artifacts;
- coordinates remain stable under transforms and viewport changes;
- alpha composition is correct;
- time/history is deterministic across preview, still, and export;
- masks, adjustment clips, stacking, and teardown are verified as applicable;
- both shader backends construct successfully;
- the canonical package builds and focused tests pass;
- the installed test bundle matches the build and is approved by exact digest.
