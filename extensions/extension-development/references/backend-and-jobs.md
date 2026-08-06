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
