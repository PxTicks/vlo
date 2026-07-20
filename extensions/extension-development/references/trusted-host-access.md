# Trusted host access

Use this reference when scoped contributions cannot express a frontend or backend
integration. Prefer scoped APIs first; trusted host access is the canonical alpha
fallback, not a permission bypass.

## Declare and discover coupling

Declare the narrowest honest application range in `manifest.json` and optional
informational metadata:

```json
{ "sdk": ">=1.0.0 <2.0.0", "vlo": ">=0.2.0 <0.3.0", "capabilities": ["host.raw"] }
```

Feature-detect `api.trusted.host.list()` or `get(id)`. Use `require(id)` only when
absence should fail activation with an extension-labelled diagnostic. `hostVersion`
may be `null`; the host warns and allows activation when it cannot verify `vlo`.
Discovery remains available if a neighbouring host entry fails its host-owned shape
assertion: `list()` marks that entry unavailable and `get()` returns `undefined`,
while the host records an error diagnostic. `require()` remains the explicit loud
path.

Session entries are `timeline.store`, `playback.clock`, `project.store`,
`userAssets.store`, `editor.focusStore`, `timeline.selectionStore`,
`library.selectionStore`, `transformations.registry`, and `extensions.runtime`;
`renderer.runtime` is availability-scoped. Returned values are exact borrowed host
identities. Use type-only imports from a matching VLO checkout to narrow them; do
not runtime-import `frontend/src/...` or serialize returned references.

## Track property patches

Use the owner-aware helper for deterministic descriptor patches:

```ts
context.api.trusted.host.patchProperty(service, "run", (previous) => ({
  ...previous,
  configurable: true,
  value: (...args: unknown[]) => {
    context.logger.debug("service.run invoked");
    return (previous?.value as (...values: unknown[]) => unknown)(...args);
  },
}));
```

Factories may rerun as stacked patches change, so keep them synchronous,
deterministic, and side-effect free. Generated wrapper identity may change. The
activation scope rolls tracked patches back on failure and deactivation. For direct
assignment, prototype/DOM interception, or third-party patch tools, capture the
original and register restoration with `context.onDispose()`.

## Use raw panel UI with explicit disposal

The complete `runtime.panelUi` barrel is the existing raw path:

```ts
const panelUi = context.api.runtime.panelUi as {
  registerCustomControl(id: string, control: unknown): void;
  unregisterCustomControl(id: string): void;
};
panelUi.registerCustomControl("example.raw/control", control);
context.onDispose(() => panelUi.unregisterCustomControl("example.raw/control"));
```

Prefer `api.ui.registerPanelControl()` when its placement and commit contract fit.

## Subscribe to a live store

Narrow the exact store identity, subscribe normally, and clean up:

```ts
const timeline = context.api.trusted.host.require("timeline.store") as {
  getState(): unknown;
  subscribe(listener: () => void): () => void;
};
const unsubscribe = timeline.subscribe(() => inspect(timeline.getState()));
context.onDispose(unsubscribe);
```

For `renderer.runtime`, subscribe to host revisions, discard the old reference on
every notification, and call `get()` again. Unavailability does not dispose the
extension.

## Use deeper backend authority carefully

Supported imports come from `services.extensions`; deeper imports are permitted but
have no SDK compatibility promise:

```py
from services.extensions import BackendExtensionDefinition
from services.extensions.host_version import VLO_APPLICATION_VERSION

original = host_service.callback
host_service.callback = wrapped_callback

def shutdown() -> None:
    if host_service.callback is wrapped_callback:
        host_service.callback = original

return BackendExtensionDefinition(shutdown=shutdown)
```

Backend V1 changes require restart. A failed patch affects the process, activation
timeouts cannot terminate running Python, and manifest capabilities do not mediate
filesystem, network, process state, or imports.
