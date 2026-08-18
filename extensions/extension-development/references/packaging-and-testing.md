# Packaging, approval, and testing

Use this reference when creating a package, changing its manifest/build, adding a
conformance fixture, or verifying activation.

## Start from the official package shape

Executable packages copy or follow `extension-template/`. Install packages as
direct children of `extensions/installed/`; `extensions/extension-development/`
is authoring tooling and is deliberately outside runtime discovery.

Keep at minimum:

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

For a static LUT-only package, omit both executable halves and declare
`contributions.luts` as a package-relative JSON catalogue. Keep each catalogue
entry owner-local, point it at a regular `.cube` resource, and use
`extension-fixtures/look-pack/` as the conformance shape. The package still uses
the exact-digest approval lifecycle, but approval executes no code. Approved,
compatible entries are projected directly from startup inventory rather than
through a synthetic frontend activation.

A Pixi filter pack remains an ordinary frontend package. Register each effect as
`trusted-filter`; use `extension-fixtures/filter-pack/` rather than introducing
a parallel shader loader.

Set manifest version, globally namespaced extension ID, display name, semantic
version, supported SDK range, explicit frontend/backend entries, and honest
capability metadata. Capabilities explain trusted authority to users but do not
enforce it.

Add a narrow optional `vlo` range when using raw host entries or deep backend
imports. Feature-detect each entry even within that range. Unknown host build
metadata warns and fails open; a known mismatch blocks approval/activation.

Add `activationEvents` when the package has nothing to do at startup, and
`dependencies` when it cannot work without another package. Both are validated
before approval — an unsupported event, an invalid peer ID, a range outside the
shared comparator grammar, or a self-reference is a manifest error. Omitting
`activationEvents` means startup, so an existing manifest keeps its behaviour.

## Build immutable frontend ESM

Produce a prebuilt ESM entry under `frontend/dist/`. Keep relative chunks/assets
inside that artifact tree. Import the SDK as types only and receive runtime
singletons through the activation context.

Retain the template guard against runtime imports of React, React DOM, Pixi,
MUI/emotion, and Zustand, plus unresolved emitted imports. Treat this as authoring
protection, not a host security boundary; custom build configurations can bypass it
and are responsible for compatibility.

Do not bundle a source-tree barrel expecting it to reach live singleton state. Use
`api.trusted.host` for runtime frontend internals and matching source imports only for
erased type information.

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
  and one timeline commit;
- `lora-policy` for reactive generation-session reads, a validated widget write, and
  a submission contributor whose graph effects reach the queued plan.

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

Run `npm run check:extension-surface` before handoff. Review every reported category:

- `public` is a supported compatibility surface;
- `host` and `adapter` are contract-sensitive implementation;
- `authoring` and `fixture` affect extension packaging or conformance;
- `governance` changes the catalogue or its guidance.

Treat the report as a review trigger, not proof of compatibility. Run behavioural
contract tests and add any missed transitive adapter to `.gitattributes`.
