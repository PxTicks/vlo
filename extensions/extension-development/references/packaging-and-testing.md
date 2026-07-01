# Packaging, approval, and testing

Use this reference when creating a package, changing its manifest/build, adding a
conformance fixture, or verifying activation.

## Start from the official package shape

Copy or follow `extension-template/`. Keep at minimum:

```text
extension-package/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.mjs
├── frontend/
│   ├── src/
│   └── dist/
└── backend/
```

Omit a half that the extension does not need. Keep Python runtime data under
`backend/` because only that subtree is staged for backend activation.

Set manifest version, globally namespaced extension ID, display name, semantic
version, supported SDK range, explicit frontend/backend entries, and honest
capability metadata. Capabilities explain trusted authority to users but do not
enforce it.

## Build immutable frontend ESM

Produce a prebuilt ESM entry under `frontend/dist/`. Keep relative chunks/assets
inside that artifact tree. Import the SDK as types only and receive runtime
singletons through the activation context.

Retain the template guard against runtime imports of React, React DOM, Pixi,
MUI/emotion, and Zustand, plus unresolved emitted imports. Treat this as authoring
protection, not a host security boundary; custom build configurations can bypass it
and are responsible for compatibility.

## Respect approval and activation

Assume scanning reads manifests and hashes files without import. Approval applies to
the exact executable digest. Any package byte change returns it to pending approval.

Expect approved frontend changes to take effect after page reload. Expect backend
entries and routers to activate at server startup and require restart after changes.
Do not claim hot backend unload.

Use the host-served content-addressed frontend entry URL. Do not construct extension
artifact or API URLs manually; use host inventory and scoped facades so sub-path
deployments work.

## Add representative contract coverage

Use `extension-fixtures/` for out-of-tree packages that prove several interfaces
compose through real packaging and approval. Keep examples as conformance fixtures,
not special cases in host code.

Choose the nearest fixture:

- `color-grade` for trusted shaders, transformations, entities, and React UI;
- `layout-prompt` for generation slots, modal canvas-like editing, and atomic input
  writes;
- `tracking` for asset upload, backend jobs, progress/cancellation, preview, mapping,
  and one timeline commit.

Add focused unit tests for validation and lifecycle, then an approval-path test for
new portable seams. Verify no code executes before approval, failed activation rolls
back registrations, deactivation disposes resources, and missing providers preserve
project data.

## Run repository verification

Read `AGENTS.md` for the current commands and interpreter. During iteration run the
focused frontend Vitest files and backend pytest files touched by the change. Before
handoff, run relevant TypeScript checks, ESLint, production build, backend extension
tests, and broader suites proportional to impact. Run the skill validator separately
when changing this skill package.
