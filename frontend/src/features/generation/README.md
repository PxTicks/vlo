# Generation Feature

The generation feature is the frontend layer for running ComfyUI workflows from
the editor. It provides:

- Workflow selection and sync with ComfyUI.
- Dynamic input rendering (text, media).
- Generation submission and job tracking.
- Live preview and output import into the asset library.

## High-level architecture

The feature is split by responsibility:

- `GenerationPanel.tsx` and `components/*`: Presentational UI.
- `hooks/useGenerationPanel.ts`: UI orchestration and derived state.
- `useGenerationStore.ts`: Main runtime state and actions.
- `services/comfyuiApi.ts`: Backend transport (`/comfy/*`).
- `services/iframeBridgeClient.ts`: Typed protocol-v2 client for vlo's hosted
  bridge runtime. The backend proxy inserts that runtime into the ComfyUI
  iframe automatically; `ComfyUI-vlo` is not an iframe dependency.
- `services/workflowBridge.ts`: Pure LiteGraph-JSON → panel input parsing.
- `services/workflowSyncController.ts`: Single owner for workflow iframe sync orchestration.
- `services/workflowRules.ts`: Rule normalization and input presentation.
- `services/parsers.ts`: Output/history parsing helpers.
- `services/warnings.ts`: Warning merge/dedup helpers.
- `store/*`: Focused store helpers for workflow, submission, delivery, and media input lifecycle.
- `utils/*`: Pre/post pipeline utilities (slot normalization, rendering, extraction).
- `constants/inputNodeMap.ts`: Frontend node class to input mapping contract.
- `constants/mediaKinds.ts`: Shared output media kind detection.

## Runtime data model

### Workflow loading state

`useGenerationStore` exposes workflow readiness explicitly:

- `workflowLoadState`: `"idle" | "loading" | "ready" | "error"`.
- `isWorkflowReady`: Derived guard for generation eligibility.
- `isWorkflowLoading`: Legacy/loading convenience flag.

Generation is gated on `isWorkflowReady && !isWorkflowLoading`.

### Jobs

Each submitted prompt is tracked as a `GenerationJob`:

- `queued -> running -> completed | error`
- all job lifecycle updates (progress, outputs, completion, errors) arrive via
  the generation delivery websocket (`store/deliveryEvents.ts`), fed by the
  backend delivery monitor
- the direct ComfyUI websocket (`services/ComfyUIWebSocket.ts`) is a
  connection-status channel only: ComfyUI unicasts per-job events to the
  submitting client_id, which is the backend monitor, never the browser

## End-to-end flow

1. User opens Generate tab.
2. `useGenerationPanel` calls `useGenerationStore.connect()`.
3. Store connects websocket and fetches workflows.
4. User selects a workflow.
5. Store sets workflow state to `loading` immediately.
6. Store loads graph/rules, then delegates iframe sync to `workflowSyncController`.
7. Synced workflow inputs are presented in UI.
8. User provides slot inputs and clicks Generate.
9. `frontendPreprocess` converts UI slot values into backend request payload.
10. Backend submits to ComfyUI; store tracks events and outputs.
11. `frontendPostprocess` imports generated outputs into user assets.

## Workflow sync ownership

Workflow synchronization with ComfyUI iframe is centralized in
`services/workflowSyncController.ts`, on top of the hosted vlo bridge:

- wait for the protocol-v2 readiness handshake and capability check
- inject the workflow (`inject-workflow` does inject + wait-active + warning
  capture + stale-tab cleanup in one round trip inside the iframe)
- read back normalized workflow inputs
- return deferral reason for retry scheduling

`ComfyUIEditor` subscribes to `graph-changed` push events for live edits
(no more per-2s full-graph polling) and runs a lightweight `health` ping for
recovery. Submission payloads come from the `resolve-prompt` request, which
runs `graphToPrompt` on a temporary graph clone inside the iframe — the live
graph is never mutated, so concurrent user edits can't be clobbered.

The bridge returns a per-workflow instance ID and revision. Submission must
present the same identity before and after prompt resolution, so switching or
editing workflows during submission fails closed with a reconnect/retry path.

## Inputs

Presented inputs come from:

- inferred inputs parsed from workflow graph nodes
- rule-defined overrides (`workflowRules`)

Selection/media extraction helpers live in:

- `utils/inputSelection.ts`
- `utils/pipeline.ts`

## Public surface

Feature exports are intentionally narrow via `index.ts`:

```ts
import { GenerationPanel, useGenerationStore } from "features/generation";
```

Types:

```ts
import type {
  WorkflowInput,
  WorkflowLoadState,
  GenerationJob,
  GenerationJobStatus,
} from "features/generation";
```

### The owner-neutral session seam

`GenerationSessionService` is a second, deliberately owner-neutral surface: the
panel mounts it and publishes the snapshot, and both native controls and the
trusted extension adapter write through the same `transaction`. Read
[docs/generation-native-extension-seams-plan.md](../../../../docs/generation-native-extension-seams-plan.md)
before changing it — §N3 documents the adapter boundary (availability, size
limits, attribution, failure-code translation), and a change here changes the
extension surface too. Two gates enforce it: `sessionSeamOwnership.test.ts`
fails on any import of `features/extensions` into the seam's import closure, and
`useGenerationSessionMount.test.tsx` pins native/extension behavioural
agreement and the published failure-code mapping.

## Testing

Primary test areas:

- Rules and input presentation: `services/__tests__/workflowRules.test.ts`
- Workflow sync controller: `services/__tests__/workflowSyncController.test.ts`
- Warning merge/parsers: `services/__tests__/warnings.test.ts`, `parsers.test.ts`
- Store workflow behavior and gating: `__tests__/useGenerationStore.rules.test.ts`
- UI warning rendering: `components/__tests__/GenerationPanel.rules.test.tsx`

Run generation tests only:

```bash
npm run test --prefix frontend -- --run src/features/generation
```

## Known contracts and cautions

- Keep `constants/inputNodeMap.ts` aligned with backend mapping in
  `backend/routers/comfyui.py` (`INPUT_NODE_MAP`).
- The ComfyUI iframe must remain same-origin through `/comfyui-frame/`.
- The backend proxy owns the iframe bridge assets and extension-list entry;
  installing `ComfyUI-vlo` is only necessary for workflows using its Python
  or memory-loader nodes.
- `workflowLoadState` should be treated as source of truth for generate-button eligibility.

Accepted delivery limitations:

- Preview frames emitted while the monitor websocket is disconnected are lost.
- SaveImageWebsocket delivery promotes its last captured frame as the output.
- The delivery consumer lease remains last-connected-wins.

## Troubleshooting

- Generate button disabled:
  - verify websocket is connected
  - verify workflow is `ready` (not `loading`/`error`)
  - verify all required workflow inputs are present
  - verify any workflow `validation.inputs` rules are satisfied

- Workflow inputs not appearing:
  - check iframe health/reconnect path
  - inspect `workflowSyncController` deferral reason

- Output missing from panel but job completed:
  - inspect the delivery manifest state (`/app/generation-delivery` routes)
  - check the backend delivery monitor logs (reconcile backstop in
    `backend/services/generation_delivery/service.py`)
