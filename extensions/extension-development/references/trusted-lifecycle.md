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
- `onDispose(resource)`: teardown for functions or disposable objects.

Return `void` or one cleanup resource. Registration facades already enrol returned
registrations with the activation scope; use `onDispose` for listeners, timers,
workers, observers, and resources created outside those facades.

Never pass an extension owner ID into a registration API. The host injects ownership
from the activation session. Expect duplicate contribution IDs to fail activation
and all registrations from a failed activation to roll back.

Keep activation lightweight. Defer large imports, model readiness, and expensive
work to user actions or backend jobs. Observe `context.signal` in asynchronous work
and prevent late writes after abort.

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
