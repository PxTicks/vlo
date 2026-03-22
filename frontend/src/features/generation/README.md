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
- `services/workflowBridge.ts`: Same-origin iframe bridge to ComfyUI app internals.
- `services/workflowSyncController.ts`: Single owner for workflow iframe sync orchestration.
- `services/workflowRules.ts`: Rule normalization and input presentation.
- `services/parsers.ts`: Output/history parsing helpers.
- `services/warnings.ts`: Warning merge/dedup helpers.
- `store/*`: Focused store helpers for workflow, submission, history, and media input lifecycle.
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
- incremental outputs from websocket `executed` events
- final output reconciliation via history fetch retry

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
`services/workflowSyncController.ts`:

- wait for iframe app readiness
- inject workflow into iframe
- read back normalized workflow inputs
- return deferral reason for retry scheduling

`ComfyUIEditor` no longer owns the workflow injection/readback sequence directly;
it triggers store actions and handles iframe health checks/recovery.

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
- `workflowLoadState` should be treated as source of truth for generate-button eligibility.

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
  - inspect history fetch retries in `store/history.ts`
  - verify backend `/history` compatibility routing
