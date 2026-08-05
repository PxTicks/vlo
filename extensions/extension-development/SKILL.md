---
name: extension-development
description: Create, review, debug, and evolve trusted vlo extensions across the TypeScript frontend and Python backend. Use when working with extension manifests, approval and activation, @vlo/extension-sdk APIs, trusted host access, raw stores/DOM/renderer integration, monkeypatching, payloads, timeline transactions, assets, Pixi transformations or entities, React UI, generation inputs, backend routes/jobs/deep imports, templates, fixtures, or new host extension interfaces. Treat restricted-mode scaffolding as subsidiary unless explicitly requested.
---

# Extension Development

Apply the scoped-first, trusted-fallback decision ladder. Trusted execution has no
intentional permission boundary after approval; a narrow TypeScript facade is not a
sandbox.

## Establish the task boundary

Classify the request before editing:

1. **Author an extension:** start with supported scoped APIs, then use canonical
   trusted host access when the scoped surface cannot express the feature.
2. **Review or debug an extension:** reproduce through the real activation and
   contribution lifecycle; distinguish extension faults from host-contract faults.
3. **Evolve the host:** add or widen a scoped contract when a seam is repeated,
   project portability needs it, or future restricted-mode value justifies it.

Assume trusted execution unless the user explicitly requests restricted mode.
Approval is informed consent, not a sandbox or malware verdict.

## Use authoritative sources

Locate the repository root, then prefer sources in this order:

1. `packages/extension-sdk/src/index.ts` for the current frontend contract.
2. `backend/services/extensions/__init__.py` for the supported Python barrel.
3. `extension-template/` for packaging and build conventions.
4. `extension-fixtures/` and contract tests for exercised composition.
5. `docs/extension-system-plan.md` for rationale and roadmap only.

If a reference in this skill conflicts with source, follow source and update the
reference in the same change. Do not promote an aspirational plan item into a V1 API.

## Load only the needed references

| Task | Read |
|---|---|
| Package identity, activation, ownership, disposal, host runtimes | [trusted-lifecycle.md](references/trusted-lifecycle.md) |
| Host internals, live stores/renderer, raw DOM/panel UI, monkeypatching, deep Python imports | [trusted-host-access.md](references/trusted-host-access.md) |
| Payloads, migrations, timeline reads/writes, tracks, selection, transport (seek/play/pause), project identity and pre-save, change subscriptions, assets, coordinate/time mapping | [persistence-timeline-assets.md](references/persistence-timeline-assets.md) |
| Pixi filters, transformations, rendered entities, live/export parity | [rendering-entities-transformations.md](references/rendering-entities-transformations.md) |
| Custom GLSL/WGSL filter extensions, shader controls, alpha, coordinates, time/history, black output, or inert sliders | [shader-filter-extensions.md](references/shader-filter-extensions.md) |
| Procedural scalars, keyframe interpolation, paths, overlays | [animation-and-paths.md](references/animation-and-paths.md) |
| React slots, modals, sidebar workspaces, canvases, commands, keybindings, menus, option catalogues, generation inputs | [ui-and-generation.md](references/ui-and-generation.md) |
| Python routers, jobs, readiness, progress, cancellation, artifacts | [backend-and-jobs.md](references/backend-and-jobs.md) |
| Manifest/build work, approval-path fixtures, and verification | [packaging-and-testing.md](references/packaging-and-testing.md) |

Read every reference implicated by a cross-domain extension. Tracking, for example,
normally needs lifecycle, assets/timeline, UI, backend jobs, and packaging.
For a shader filter, read the shader reference together with lifecycle, rendering,
and packaging/testing.

## Follow the implementation workflow

1. Inspect the current interfaces and a nearby conformance fixture.
2. List the frontend and backend contributions the extension needs.
3. Define a globally namespaced manifest ID, stable local contribution IDs,
   versioned JSON data, capabilities, and teardown first.
4. Use a code-free declarative look pack for static `.cube` resources, an
   ordinary `trusted-filter` frontend extension for Pixi filter packs, or start
   other executable work from `extension-template/`.
5. For executable packages, register contributions inside `activate(context)`;
   use scoped APIs first and `api.trusted.host` when they are materially
   insufficient. Declarative look-pack catalogues are projected by the host and
   do not execute `activate()`.
6. Put user-visible writes in synchronous labelled transactions.
7. Exercise failure, disposal, missing-provider, and reload behaviour as applicable.
8. Verify through focused tests, package build, and approval-path coverage.

## Preserve trusted-system invariants

- Let the host inject registration ownership; never accept or forge an owner ID.
- Honour `context.signal` and register every long-lived resource for disposal.
- Import `@vlo/extension-sdk` as types only. Use injected host React, Pixi, MUI,
  and panel UI runtimes to avoid duplicate singleton trees.
- Keep persisted provider data finite, JSON-serialisable, versioned, validated, and
  migratable. Declare asset references without treating them as clip ownership.
- Prefer timeline and generation commands. If raw mutation is required, own undo,
  validation, persistence, export, and teardown consequences explicitly.
- Keep render and animation callbacks synchronous, deterministic, and cacheable.
  Move I/O and heavy AI/model work into backend jobs.
- Preserve identical provider behaviour in live preview, still capture, and export.
- Treat installed package resources as sources. Materialize durable bytes through
  `assets.ingest` before persisting their project asset ID.
- Obtain live frontend internals through `api.trusted.host`, not runtime source-tree
  imports that may fail or bundle duplicate module state.
- Keep host attachment, compositing, and final destruction of Pixi objects in host
  adapters. Extensions own object contents and extra resources.

## Evolve host contracts carefully

Use the common registry kernel for owner binding, duplicate rejection, rollback,
diagnostics, and disposal. Promote repeated raw seams into narrow domain contracts
without removing the trusted fallback. Generalise from the capability being enabled,
not the first example. Add an out-of-tree conformance fixture for author-facing seams.

Keep declarative descriptors and JSON envelopes compatible with future restricted
execution where practical, but do not weaken trusted APIs around a speculative
sandbox. Restricted callbacks, UI, and backend code require separate mediation and
real process/origin boundaries.

## Verify

Read the repository `AGENTS.md` before running commands. Use the configured frontend
test/typecheck/build commands and the available backend virtualenv interpreter.
Prefer focused tests while iterating, then run the relevant broad suites. Validate
that no package code executes before approval and that activation failure or
deactivation leaves no owned contributions behind.
