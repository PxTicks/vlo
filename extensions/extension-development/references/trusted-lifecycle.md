# Trusted lifecycle and runtime

Use this reference for package activation, frontend ownership, host runtimes, and
trusted-mode boundaries. Read `packages/extension-sdk/src/index.ts` before relying on
exact signatures.

## Treat trust accurately

- Describe approval as consent to run one exact package digest.
- Assume approved frontend code has main-page authority and approved in-process
  Python has backend-process authority.
- Treat manifest capabilities as user-facing metadata in trusted mode, not enforced
  permissions.
- Distinguish compatibility guarantees from reachability: internal barrels may be
  usable by version-coupled extensions, but only the SDK is stable.

## Activate through the host context

Export a named frontend `activate(context)` function matching `ExtensionModule`.
Use these context members:

- `extension`: host-supplied immutable ID and version;
- `sdkVersion`: active host SDK version;
- `api`: owner-bound domain facades;
- `signal`: cancellation on rollback/deactivation;
- `logger`: extension-labelled diagnostics;
- `onDispose(resource)`: teardown for functions or disposable objects;
- `exportApi(api)`: publish your API for packages that declare you as a
  dependency.

Return `void` or one cleanup resource. Registration facades already enrol returned
registrations with the activation scope; use `onDispose` for listeners, timers,
workers, observers, and resources created outside those facades.

Never pass an extension owner ID into a registration API. The host injects ownership
from the activation session. Expect duplicate contribution IDs to fail activation
and all registrations from a failed activation to roll back.

Keep activation lightweight. Defer large imports, model readiness, and expensive
work to user actions or backend jobs. Observe `context.signal` in asynchronous work
and prevent late writes after abort.

Declarative manifest contributions do not use this executable lifecycle. The host
projects approved, compatible look-pack catalogues directly from startup inventory
and reconciles each package digest atomically. In mixed packages, that projection is
independent of frontend code activation, so activation failure does not suppress
valid static resources. V1 still applies inventory changes after page reload.

## Declare when the host should activate you

A manifest with no `activationEvents` activates at startup, in inventory order.
Declare events instead when you have nothing to do before something happens:

- `"onStartup"` — as soon as the inventory is read;
- `"onProjectOpen"` — when a project opens, or immediately if one already is;
- `"onExtension:<id>"` — after the named package activates, for an optional
  companion.

The host validates these before approval, so a typo is a manifest error rather
than a package that silently never runs. An event a future host retires degrades
to startup instead of stranding you.

## Compose with another package

Declare a hard dependency in the manifest — `"dependencies": { "example.other":
">=1.2.0 <2.0.0" }` — using the same comparator grammar as `sdk` and `vlo`. The
host then activates that package **before** you, whatever its own activation
events say, and refuses you outright (with a `dependencies`-stage diagnostic) if
it is missing, version-mismatched, or failed. Cycles are refused, not resolved.

The provider publishes with `context.exportApi(value)`. The host holds it until
activation succeeds and retracts it when the package deactivates, so a dependent
can never hold an API from a session that was rolled back. Calling it twice
replaces the value; a non-object throws.

The consumer reads through `api.extensions`:

- `listDependencies()` — what you declared, resolved, with `isActive`/`hasApi`;
- `getApi(id)` — the value, or `undefined` if that package exported none;
- `requireApi(id)` — the same, but throws when nothing is available.

Both throw for a package you did not declare: that is a missing manifest entry,
not a state of the editor. Narrow the peer's shape in your own code rather than
importing its source — the two packages ship and version separately. Do not
cache a peer API across deactivation, and treat a breaking change to a value you
export as a major version of your package.

## Use host singleton runtimes

Import `@vlo/extension-sdk` with `import type`. Obtain runtime values from:

- `context.api.runtime.react`;
- `context.api.runtime.pixi`;
- `context.api.runtime.mui`;
- `context.api.runtime.panelUi`.

`panelUi` is the complete live host barrel, including raw registry functions; it is
not a curated permission boundary. Scoped UI registration remains preferable for
ownership and rollback.

Do not bundle runtime copies of React, React DOM, Pixi, MUI/emotion, or Zustand.
Duplicate React breaks hooks/context and duplicate Pixi produces objects the host
cannot safely recognise. Use matching packages only as development dependencies for
type-only narrowing when necessary.

Use `context.api.trusted.host` for other live composition roots. The lookup mechanism
is supported, while entry IDs and returned shapes are version-coupled. Session
entries retain identity; availability entries may disappear or be replaced after a
revision notification and must be re-resolved. Never persist a live reference.

## Respect the backend activation boundary

Import supported Python types from `services.extensions` for SDK compatibility.
Deeper host imports and reversible monkeypatches are permitted when that surface is
insufficient, but they are coupled to the claimed VLO version and should be restored
from `BackendExtensionDefinition.shutdown` where practical.
Define a factory named by `manifest.json` and accept `BackendExtensionContext`.
Return `None`, an `APIRouter`, or `BackendExtensionDefinition`.

Treat `context.package_dir` as the staged `backend/` subtree, not the complete source
package. Keep backend runtime resources beneath `backend/`. Keep the factory below
the host activation budget and put expensive work in registered jobs. Backend route
or code changes require restart in V1; do not promise hot unload.

Remember that an activation timeout lets core startup continue but cannot kill
already-running trusted Python work. Keep factories cooperative and side-effect
light.
