---
name: extension-development
description: Create, review, debug, and evolve trusted vlo extensions across the TypeScript frontend and Python backend. Use when working with extension manifests, approval and activation, @vlo/extension-sdk APIs, payloads, timeline transactions, assets, Pixi transformations or entities, scalar animation and spatial paths, React UI slots/modals/workspaces, generation inputs, backend routes/jobs/artifacts, the extension template, conformance fixtures, or new host extension interfaces. Treat restricted-mode scaffolding as subsidiary unless explicitly requested.
---

# Extension Development

Develop against the trusted SDK first. Treat motivating extensions as conformance
cases that widen the platform, never as reasons to hard-code one product feature.

## Establish the task boundary

Classify the request before editing:

1. **Author an extension:** prefer supported extension APIs and keep host changes out
   of scope unless the requested capability is genuinely absent.
2. **Review or debug an extension:** reproduce through the real activation and
   contribution lifecycle; distinguish extension faults from host-contract faults.
3. **Evolve the host:** preserve the shared ownership/lifecycle spine and add a
   domain contract rather than exposing raw stores, stages, or arbitrary owner IDs.

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
| Payloads, migrations, timeline reads/writes, assets, coordinate/time mapping | [persistence-timeline-assets.md](references/persistence-timeline-assets.md) |
| Pixi filters, transformations, rendered entities, live/export parity | [rendering-entities-transformations.md](references/rendering-entities-transformations.md) |
| Procedural scalars, keyframe interpolation, paths, overlays | [animation-and-paths.md](references/animation-and-paths.md) |
| React slots, modals, sidebar workspaces, canvases, generation inputs | [ui-and-generation.md](references/ui-and-generation.md) |
| Python routers, jobs, readiness, progress, cancellation, artifacts | [backend-and-jobs.md](references/backend-and-jobs.md) |
| Manifest/build work, approval-path fixtures, and verification | [packaging-and-testing.md](references/packaging-and-testing.md) |

Read every reference implicated by a cross-domain extension. Tracking, for example,
normally needs lifecycle, assets/timeline, UI, backend jobs, and packaging.

## Follow the implementation workflow

1. Inspect the current interfaces and a nearby conformance fixture.
2. List the frontend and backend contributions the extension needs.
3. Define a globally namespaced manifest ID, stable local contribution IDs,
   versioned JSON data, capabilities, and teardown first.
4. Start from `extension-template/` or preserve its type-only SDK/runtime-singleton
   rules in an existing package.
5. Register contributions only inside `activate(context)` and use the scoped APIs.
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
- Use timeline and generation command facades instead of raw Zustand mutation.
- Keep render and animation callbacks synchronous, deterministic, and cacheable.
  Move I/O and heavy AI/model work into backend jobs.
- Preserve identical provider behaviour in live preview, still capture, and export.
- Treat internal feature barrels as permitted but version-coupled trusted escape
  hatches, never as portable SDK guarantees.
- Keep host attachment, compositing, and final destruction of Pixi objects in host
  adapters. Extensions own object contents and extra resources.

## Evolve host contracts carefully

Use the common registry kernel for owner binding, duplicate rejection, rollback,
diagnostics, and disposal. Add narrow domain commands instead of exposing mutable
stores. Generalise from the capability being enabled, not the first example. Add an
out-of-tree conformance fixture when a new seam is meant for extension authors.

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
