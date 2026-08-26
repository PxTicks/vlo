# Backend routes, jobs, and artifacts

Use this reference for trusted Python extensions and the owner-bound frontend
`backend` client. Read `backend/services/extensions/__init__.py` for the current
supported Python surface.

## Define the backend factory

Point `manifest.json` at `module.path:create_extension` beneath the staged
`backend/` subtree. Import public types from `services.extensions`.

Accept `BackendExtensionContext`, which supplies extension identity, SDK version,
staged package directory, labelled logger, and raw API prefix. Return:

- `None` when the extension has no routes, jobs, or shutdown work;
- an `APIRouter` for raw routes only; or
- `BackendExtensionDefinition(router=..., jobs=..., shutdown=...)`.

Prefer the definition form when registering jobs or cleanup. Keep the factory
lightweight and avoid model loading during server startup. Routes are mounted below
the extension's host-owned `/api` namespace; never assume a global route.

Use the shutdown callback for resources owned by the active backend session. Expect
enable/code changes to require backend restart in V1.

The `services.extensions` barrel is the supported compatibility contract, not an
authority ceiling. Trusted in-process code may import deeper host modules, inspect
process state, use filesystem/network APIs, or monkeypatch Python objects when the
supported surface is insufficient. Declare the VLO range, restore hooks in shutdown
where practical, and accept that deep shapes can change without an SDK-major bump.

## Declare Python dependencies for the preflight checklist

The host never installs Python packages: backend extensions run in-process in the
single shared `backend/.venv`, so any third-party import must already be present
there. Declare each required top-level import in the manifest so the extension
manager can show the user an inert readiness checklist before approval:

```json
"pythonDependencies": [
  { "module": "torch", "distribution": "torch", "purpose": "GPU inference" },
  { "module": "whisper", "distribution": "openai-whisper" }
]
```

`module` is a single top-level import name the host probes with `importlib` (never
executing package code); `distribution` is the pip/uv install name shown in the
generated hint; `purpose` is a short human note. The manager marks each dependency
satisfied or missing and reports the environment the probe actually resolved
against — the backend's own `sys.prefix`, which is authoritative regardless of
shell activation. When anything is missing it prints `pip` and `uv` commands that
target the live interpreter by absolute path (`sys.executable`), so they are correct
for a plain venv or a uv-managed one. This is advisory only — it does not gate
approval or activation, and readiness callbacks on individual jobs remain the place
to fail cleanly when a model or dependency is unavailable at run time.

## Register long-running work as jobs

The lifecycle beneath this public facade is also used by built-in host jobs
such as SAM Audio. Its queueing, cancellation, timeout, progress, diagnostics,
and ephemeral artifact mechanics are owner-neutral; the extension host adds
package identity, owner isolation, public serialization, and route/error
mapping. Keep extension code on the supported `services.extensions` imports,
but expect native and extension job changes to require paired behavioural
coverage because they exercise the same kernel.

Create `BackendJobDefinition` with:

- stable local `id` (owner-qualified by the host) and user-facing `label`;
- `run(context, input)`;
- optional finite-JSON input and result validators;
- optional readiness callback;
- a finite timeout.

Keep validators and readiness checks lightweight. Return `BackendJobReadiness` with
an actionable message and optional finite JSON details. Put dependency/model loading
inside the runner or an explicitly managed lazy service.

In the runner:

- call `context.raise_if_cancelled()` regularly;
- report monotonic progress with `report_progress`;
- emit bounded structured diagnostics with `report_diagnostic`;
- read only supplied input artifact IDs through `context.artifacts.read`;
- create outputs through `context.artifacts.create`;
- return finite JSON describing the result and its artifacts.

Cancellation and timeout are cooperative for synchronous Python work. A runner that
ignores cancellation may retain its thread after the public job is terminal. Jobs
waiting behind that worker remain truthfully `queued`; their execution timeout begins
only when a worker starts them. Avoid uninterruptible loops and release
extension-owned resources in all terminal paths.

## Declare a job that uses the GPU

A job that runs a model on the local GPU must hold the machine's one
`local-gpu` reservation for the whole of its execution, so it cannot be
resident at the same time as SAM2, SAM-Audio, a local ComfyUI prompt, or
another extension's model. Declare it and the host takes the lease:

```python
BackendJobDefinition(
    id="track",
    label="Track subject",
    run=_run_tracking,          # must be synchronous
    readiness=_readiness,
    uses_local_gpu=True,
)
```

You do not take the lease yourself, and there is no API for doing so: a job
that volunteered for admission is a job that can forget, and forgetting is
invisible until two models are on the card. What follows from the declaration:

- **The wait is not your execution time.** The job stays `queued` while it
  waits, and its `timeout_seconds` starts only when it is admitted. It waits up
  to 30 minutes for the GPU before failing.
- **The runner must be synchronous** and must not return an awaitable. The
  lease is released by the thread that ran your callable, when it returns; work
  handed back to the event loop would outlive it, with the model still
  resident. Both are refused — the first at registration, the second at run
  time.
- **Cancellation leaves the queue.** A job cancelled while waiting stops
  waiting rather than being admitted to work nobody wants. A job cancelled
  while running is publicly `cancelled` immediately, and the queue shows the
  entry as `stopping` until your callable actually returns — so keep calling
  `context.raise_if_cancelled()`.
- **Progress reaches the queue panel**, not just your job: `report_progress`
  mirrors into the ledger entry, which is labelled with your extension's id.
- Nested host inference (reading SAM2 mask frames, say) passes straight
  through: the thread already holds the lease.
- **Waiting costs nothing.** A queued GPU job holds no worker thread, so it
  cannot delay other extensions' CPU jobs; admitted GPU jobs run on a pool of
  their own. Still declare `uses_local_gpu` only for work that actually touches
  the GPU — it is what excludes every other model on the machine.

A capability descriptor takes the same `uses_local_gpu` flag, which is what
makes its Test-runtime probe take the lease. Declare both: the descriptor's
flag covers the load test, the job's covers the real work.

Ownership, quota and cancellation stay yours. Only the reservation is shared —
as the host's own `backend-process` tenant, because your model runs in the vlo
process, in its CUDA context, against its VRAM.

## Call jobs from the frontend

Use the owner-bound `context.api.backend` facade:

1. Check `listJobs()` readiness.
2. Upload browser bytes with `uploadArtifact`.
3. Call `submitJob(jobType, input, artifactIds)`.
4. Use `waitForJob` with `signal`, progress callback, and appropriate polling.
5. Call `cancelJob` when the user cancels.
6. Fetch output bytes with `getArtifact` or use `getArtifactUrl` where suitable.

Use `backend.call(path, init)` only as a trusted raw-route escape hatch. Keep paths
relative to the extension API and use the facade so deployment base paths remain
correct.

Do not send backend filesystem paths from frontend assets. Exchange bytes through
artifact tokens. Treat uploaded and generated job artifacts as ephemeral; import any
result that must persist into an appropriate host/project asset flow.

## Register a model runtime as a capability

An extension whose backend loads its own weights should register a runtime
capability rather than inventing a private "is it installed" endpoint. A
capability is what makes the host's readiness contract available to it: staged
checks, classified failures, install remediation, a recorded load boundary, and
a card in Runtime Diagnostics.

Register through the registrar on the context — never `register_descriptor`
directly. The host owns the id, the lifetime, and the admission rules:

```python
from services.extensions import CapabilityDescriptor, PackageSpec, lazy_runtime

def create_extension(ctx):
    capability_id = ctx.capabilities.register(
        CapabilityDescriptor(
            id="tracker",                      # local name; the host namespaces it
            label="Acme Tracker",
            packages=(
                PackageSpec(
                    module="acme_tracker",
                    install_target="acme-tracker>=1.0",
                    install_summary="Install the Acme tracker runtime",
                ),
            ),
            python_min=(3, 10),
            loader=build_tracker,              # a callable, or "module:attr"
            discover_models=discover_weights,  # (descriptor) -> Discovery
        )
    )
```

The returned id is namespaced — `acme.tracking:tracker` — so no extension can
claim `sam2` or collide with a neighbour, and the registration is released when
the extension deactivates, taking its memo cell, recorded failure, and load
observation with it. Some descriptor fields are host-owned and are refused:
`app_status_key`, `profile` (installer profiles install host requirements files;
declare `PackageSpec.install_target` instead), and, until extension jobs pass
through the model-work coordinator, `uses_local_gpu`.

Obtain the runtime only through `lazy_runtime(capability_id).get()`. That call
is the load boundary: it memoises, classifies a failure, records it, and notes
success. There is no unrecorded way to load the model, which is the point —
nothing to remember, so nothing to forget.

Derive a job's `readiness` callback from the same capability, with
`capability_runtime_health(capability_id)` from the same barrel, so a job that
cannot run and a card that says why are the same fact rather than two opinions.

Weights remain yours to distribute: the host's model manager does not know about
extension models, so prefer a `docs` or `settings` remediation over `download`,
and ship your own fetch through a route or job.

## Read capability state from the frontend

`context.api.capabilities` is the frontend half. It is a projection over the
host's own single-flight capability store, so your panel and the Runtime
Diagnostics panel read one answer and serialise their rechecks against each
other:

```ts
const { capabilities } = context.api;
await capabilities.ensureLoaded();

const tracker = capabilities.read("tracker");   // local name or namespaced id
if (!tracker.canAttempt) {
  // tracker.failureCode, tracker.failure.remediation — already classified
}
```

- `list`, `get`, `read`, `getStatus`, `ensureLoaded` read your own
  capabilities; `subscribe` and `getRevision` follow changes; `recheck` re-runs
  the checks and `test` loads the runtime for real (the host's "Test runtime"
  action, and the only thing that raises `verifiedThrough` to `"loaded"`).
- **A bare name is always yours.** `"tracker"` and `"acme.tracking:tracker"`
  address the same capability. Host capabilities are read through `getHost` /
  `readHost` — gating a feature on SAM2 is legitimate, and read-only. Another
  extension's capability throws either way. The split is what stops a host
  capability added in a later release from silently retargeting an id you
  already ship.
- **Snapshots are detached.** Every returned capability is a deep-frozen copy,
  so what you hold cannot change under you and cannot reach host state.
- `recheck` and `test` return a result, not just a view:
  `{ ok: true, view }`, or `{ ok: false, status, error, view }` when the backend
  was unreachable, the probe failed, or your extension deactivated mid-test
  (`status: "cancelled"`). On failure `view` is the *previous* reading — the
  store keeps the last good snapshot — so branch on `ok`, not on the view.
  Concurrent calls for one capability join the run already in flight.
- Before the first read there is no answer yet: `read()` reports `checking`, and
  `canAttempt` is `false`. Render "still looking", never "unavailable" — a cold
  read runs out-of-process probes and takes seconds.
- `capabilities.FailureNotice` is the host's own remediation UI as a React
  component. Render it through `api.runtime.react`, unconditionally above your
  controls; it reads the capability itself and renders nothing when nothing is
  wrong:

  ```ts
  const React = context.api.runtime.react;
  React.createElement(capabilities.FailureNotice, {
    capabilityId: "tracker",
    downloadSurface: myDownloadUi,   // shown only for missing model files
  });
  ```

  Pass `host: true` to present a host capability's notice instead of your own.

Gate the feature on `canAttempt` and nothing else. Do not re-derive readiness
from package probes, a private endpoint, or the presence of a file.
