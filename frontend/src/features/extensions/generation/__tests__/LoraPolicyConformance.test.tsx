import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";
import { ExtensionUiSlot } from "../../ui/ExtensionUiSlot";
import type { ExtensionModule, VloExtensionApi } from "../../types";
import { generationSessionService } from "../../../generation/services/GenerationSessionService";
import { projectGenerationSession } from "../generationSessionProjection";
import { generationSubmissionContributors } from "../../../generation/services/generationSubmissionContributors";
import { buildExecutionStoreState } from "../../../generation/store/executionStoreState";
import {
  bridgeEffectPayloadsMatch,
  buildBridgeEffectPayload,
  captureGenerationEffectsForPlan,
  collectGenerationEffectErrors,
} from "../../../generation/pipeline/generationGraphEffects";
import type {
  GenerationContributedEffectGroup,
  GenerationPlan,
} from "../../../generation/pipeline/types";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationNodeSnapshot,
  GenerationWidgetSnapshot,
} from "../../../generation/services/generationSessionTypes";
import type { WorkflowRules } from "../../../generation/services/workflowRules";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import {
  createSubgraphHarness,
  liveNodeAt,
  resolveScopedPrompt,
  type FakeGraphData,
} from "../../../../testUtils/comfyBridgeSubgraph";
import {
  activate,
  BYPASS_CHOICE,
  MAX_BYPASS_NODES_PER_EFFECT,
  MAX_CONTRIBUTED_EFFECTS,
  planLoaderEffects,
  resetLoraPolicyStateForConformance,
} from "../../../../../../extension-fixtures/lora-policy/frontend/src/index";

/**
 * The out-of-tree LoRA-loader policy fixture, end to end
 * (docs/generation-extension-surface-plan.md E3).
 *
 * Everything the fixture touches is public API: it is activated through the
 * real extension host, reads the mounted session through the real generation
 * adapter, renders in the real UI slot, and its contribution travels the real
 * capture path into the real ComfyUI bridge. The suite exists to prove the MVP
 * surface is sufficient for a trusted policy extension — no match, one match,
 * many matches, root and scoped targets, sibling isolation, staleness,
 * invalid values, collisions, provider failure, unload, and queued replay.
 */

const EXTENSION_ID = "example.lora-policy";
const CONTRIBUTOR_SOURCE = `extension:${EXTENSION_ID}/policy`;
const MODELS = [
  "forest.safetensors",
  "city.safetensors",
  "portrait.safetensors",
] as const;
const WORKFLOW = { sourceId: "workflow-1", instanceId: "instance-1" };
const EXPECTATION = { workflowInstanceId: WORKFLOW.instanceId, revision: 1 };

function modelWidget(
  nodeId: string,
  value: string = MODELS[0],
  options: readonly string[] = MODELS,
): GenerationWidgetSnapshot {
  return {
    nodeId,
    param: "lora_name",
    valueType: "enum",
    value,
    defaultValue: MODELS[0],
    options: [...options],
    min: null,
    max: null,
    step: null,
    linked: false,
    controlAfterGenerate: false,
  };
}

function loaderNode(
  id: string,
  overrides: {
    title?: string;
    classType?: string;
    value?: string;
    options?: readonly string[];
    mode?: number;
  } = {},
): GenerationNodeSnapshot {
  return {
    id,
    classType: overrides.classType ?? "LoraLoaderModelOnly",
    title: overrides.title ?? `Loader ${id}`,
    mode: overrides.mode ?? 0,
    widgets: [modelWidget(id, overrides.value, overrides.options)],
  };
}

const SAMPLER_NODE: GenerationNodeSnapshot = {
  id: "9",
  classType: "KSampler",
  title: "Sampler",
  mode: 0,
  widgets: [
    {
      nodeId: "9",
      param: "seed",
      valueType: "int",
      value: 7,
      defaultValue: 0,
      options: null,
      min: 0,
      max: 1_000,
      step: 1,
      linked: false,
      controlAfterGenerate: true,
    },
  ],
};

/** A panel control for one loader's model widget, making it `setWidget`-able. */
function editableModelWidget(nodeId: string): GenerationEditableWidgetSnapshot {
  return {
    target: { nodeId, widget: "lora_name" },
    valueType: "enum",
    value: MODELS[0],
    options: [...MODELS],
    min: null,
    max: null,
    trueValue: null,
    falseValue: null,
  };
}

/**
 * The graph the workflow snapshots describe, as ComfyUI would hold it.
 *
 * `12` instantiates its definition once, so `12:6` is a uniquely addressable
 * scoped target; `10` and `11` share one definition, so `10:5` and `11:5` are
 * the same node object and must fail closed rather than move together.
 */
function loaderGraph(): FakeGraphData {
  return {
    nodes: [
      {
        id: "4",
        type: "LoraLoader",
        widgets: [
          { name: "lora_name", value: MODELS[0] },
          { name: "strength_model", value: 1 },
        ],
      },
      { id: "9", type: "KSampler", widgets: [{ name: "seed", value: 7 }] },
      { id: "12", type: "def-solo", subgraphId: "def-solo" },
      { id: "10", type: "def-shared", subgraphId: "def-shared" },
      { id: "11", type: "def-shared", subgraphId: "def-shared" },
    ],
    definitions: {
      "def-solo": [
        {
          id: "6",
          type: "LoraLoaderModelOnly",
          widgets: [{ name: "lora_name", value: MODELS[0] }],
        },
      ],
      "def-shared": [
        {
          id: "5",
          type: "LoraLoaderModelOnly",
          widgets: [{ name: "lora_name", value: MODELS[0] }],
        },
      ],
    },
  };
}

/** The session catalogue for {@link loaderGraph}, in execution ids. */
const GRAPH_NODES: readonly GenerationNodeSnapshot[] = [
  loaderNode("4", { classType: "LoraLoader", title: "Root loader" }),
  SAMPLER_NODE,
  loaderNode("12:6", { title: "Solo instance loader" }),
  loaderNode("10:5", { title: "Shared instance A" }),
  loaderNode("11:5", { title: "Shared instance B" }),
];

function makePlan(options: {
  contributedEffects?: readonly GenerationContributedEffectGroup[];
  workflowRules?: unknown;
} = {}): GenerationPlan {
  return {
    id: "plan-1",
    createdAt: 0,
    workflow: {
      workflow: null,
      graphData: null,
      workflowId: WORKFLOW.sourceId,
      workflowRules: (options.workflowRules ?? null) as WorkflowRules | null,
      workflowInputs: [],
      submittedWorkflow: null,
      promptIsPreResolved: false,
    },
    preprocess: {
      slotValues: {},
      derivedMaskMappings: [],
      projectConfig: { fps: 30, aspectRatio: "16:9" },
      exactAspectRatio: false,
      targetResolution: 720,
      maskCropDilation: 0,
      maskCropMode: "full",
    },
    submission: {
      widgetInputs: {},
      frontendStateWidgetValues: {},
      inputMetadata: {},
      widgetModes: {},
      derivedWidgetInputs: {},
      bypassNodeIds: [],
      contributedEffects: options.contributedEffects ?? [],
    },
    metadata: {
      generationMetadata: {} as GenerationPlan["metadata"]["generationMetadata"],
      workflowWarnings: [],
    },
    postprocess: {
      config: {
        mode: "auto",
        panel_preview: "raw_outputs",
        on_failure: "fallback_raw",
      },
    },
    effects: null,
  };
}

/** Ask the registry for this submission's contributions, as the store does. */
function collectContributions(
  expected: { sourceId: string | null; instanceId: string | null } = WORKFLOW,
): readonly GenerationContributedEffectGroup[] {
  return generationSubmissionContributors.collect(
    generationSessionService.getSnapshot(),
    expected,
  );
}

/**
 * The real execution-store slice over a plain state object.
 *
 * Only the collaborators a queued-but-undispatched submission needs are set:
 * the connection is down and there is no editor, so `queueGeneration` builds
 * and captures plans — which is the part a contribution travels through — and
 * then leaves them in the queue instead of talking to ComfyUI.
 */
function createQueueHarness() {
  let state: Record<string, unknown> = {
    jobs: new Map(),
    jobPreviewFrames: new Map(),
    activeJobId: null,
    generationQueue: [],
    pipelineRunToken: 0,
    wsClient: null,
    runtimeStatus: { comfyui: { status: "error", error: null } },
    connectionStatus: "error",
    isWorkflowLoading: false,
    isWorkflowReady: true,
    preResolvedPromptEnabled: true,
    editorRef: null,
    selectedWorkflowId: WORKFLOW.sourceId,
    iframeWorkflowInstanceId: WORKFLOW.instanceId,
    iframeWorkflowRevision: 1,
    availableWorkflows: [],
    activeWorkflowRules: null,
    activeRulesWarnings: [],
    workflowInputs: [],
    syncedWorkflow: {},
    syncedGraphData: { nodes: [] },
    mediaInputs: {},
    derivedMaskMappings: [],
    exactAspectRatio: false,
    targetResolution: 720,
    maskCropMode: "full",
    maskCropDilation: 0,
    workflowRuleWarnings: [],
  };
  const get = () => state;
  const set = (
    update:
      | Record<string, unknown>
      | ((current: Record<string, unknown>) => Record<string, unknown>),
  ) => {
    const patch = typeof update === "function" ? update(state) : update;
    state = { ...state, ...patch };
  };
  const actions = buildExecutionStoreState(set as never, get as never);
  state = { ...state, ...actions };
  return {
    get state() {
      return state;
    },
    actions,
  };
}

const hosts: ExtensionHost<VloExtensionApi>[] = [];
let session: MountedGenerationSession | undefined;

function createHost(): ExtensionHost<VloExtensionApi> {
  const host = new ExtensionHost<VloExtensionApi>({
    sdkVersion: VLO_EXTENSION_SDK_VERSION,
    createApi: createVloExtensionApi,
  });
  hosts.push(host);
  return host;
}

async function activateFixture(
  nodes: readonly GenerationNodeSnapshot[],
  editableWidgets: readonly GenerationEditableWidgetSnapshot[] = [],
): Promise<ExtensionHost<VloExtensionApi>> {
  session = mountGenerationSession({ ...WORKFLOW, nodes, editableWidgets });
  const host = createHost();
  await host.activate({ id: EXTENSION_ID, version: "1.0.0" }, { activate });
  return host;
}

function selectModel(loaderTitle: string, value: string): void {
  fireEvent.change(screen.getByLabelText(`LoRA for ${loaderTitle}`), {
    target: { value },
  });
}

afterEach(async () => {
  // Unmount first: deactivation and the store reset below both notify the
  // panel's subscriptions, and a live component reacting to them outside
  // React's test scope is a warning about this suite, not about the fixture.
  cleanup();
  for (const host of hosts.splice(0)) {
    for (const state of host.listStates()) await host.deactivate(state.id);
  }
  resetLoraPolicyStateForConformance();
  session?.unmount();
  session = undefined;
});

describe("LoRA loader policy conformance fixture", () => {
  it("finds nothing to configure in a workflow without a loader", async () => {
    await activateFixture([SAMPLER_NODE]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "No compatible LoRA loader in this workflow.",
    );
    expect(collectContributions()).toEqual([
      {
        source: CONTRIBUTOR_SOURCE,
        workflow: {
          sourceId: WORKFLOW.sourceId,
          instanceId: WORKFLOW.instanceId,
          fingerprint: "fingerprint-1",
        },
        bypassNodeIds: [],
        widgetOverrides: [],
        diagnostics: [],
      },
    ]);
  });

  it("lists the models the widget metadata exposes and writes an editable choice", async () => {
    await activateFixture(
      [loaderNode("4", { classType: "LoraLoader", title: "Root loader" })],
      [editableModelWidget("4")],
    );
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    const select = screen.getByLabelText("LoRA for Root loader");
    expect(
      [...select.querySelectorAll("option")].map((option) => option.value),
    ).toEqual([BYPASS_CHOICE, ...MODELS]);

    selectModel("Root loader", MODELS[1]);

    // The panel has a control for this widget, so the choice is applied to the
    // live panel immediately as well as planned for the submission.
    expect(session?.commit).toHaveBeenCalledOnce();
    expect(session?.commit.mock.calls[0][0].widgets).toEqual([
      { target: { nodeId: "4", widget: "lora_name" }, value: MODELS[1] },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      `Root loader is set to ${MODELS[1]} now, and in the next generation.`,
    );
    expect(collectContributions()[0]).toMatchObject({
      source: CONTRIBUTOR_SOURCE,
      bypassNodeIds: [],
      widgetOverrides: [
        { node_id: "4", widget: "lora_name", value: MODELS[1] },
      ],
      diagnostics: [],
    });
  });

  it("plans each discovered loader independently", async () => {
    await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    // Four loaders, one sampler: discovery matches on class *and* widget.
    expect(screen.getAllByRole("combobox")).toHaveLength(4);

    selectModel("Root loader", MODELS[1]);
    selectModel("Solo instance loader", BYPASS_CHOICE);
    // "Shared instance A" is left untouched, and contributes nothing.

    expect(session?.commit).toHaveBeenCalledOnce();
    expect(collectContributions()[0]).toMatchObject({
      bypassNodeIds: ["12:6"],
      widgetOverrides: [
        { node_id: "4", widget: "lora_name", value: MODELS[1] },
      ],
      diagnostics: [],
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Solo instance loader will be bypassed in the next generation.",
    );
  });

  it("says so, and writes nothing now, when the panel has no control", async () => {
    await activateFixture(GRAPH_NODES);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    selectModel("Solo instance loader", MODELS[2]);

    expect(session?.commit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      `Solo instance loader has no panel control; ${MODELS[2]} is applied when you generate.`,
    );
    expect(collectContributions()[0]).toMatchObject({
      bypassNodeIds: [],
      widgetOverrides: [
        { node_id: "12:6", widget: "lora_name", value: MODELS[2] },
      ],
    });
  });

  it("follows the mounted session without being re-rendered by the host", async () => {
    await activateFixture([SAMPLER_NODE]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    // A workflow switch is a publication, not a remount: the panel is the same
    // React tree, and `subscribe`/`getSession` are what make the loader appear.
    act(() => {
      session?.publish({
        ...WORKFLOW,
        nodes: GRAPH_NODES,
        editableWidgets: [editableModelWidget("4")],
      });
    });
    expect(screen.getAllByRole("combobox")).toHaveLength(4);

    act(() => session?.unmount());
    expect(screen.getByRole("status")).toHaveTextContent(
      "The generation panel is not mounted.",
    );
  });

  it("shows and contributes nothing for a workflow that reuses the same node ids", async () => {
    await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", MODELS[1]);

    // Another workflow, same node id, different graph. What the panel shows
    // and what the contributor plans have to agree — a control displaying the
    // previous workflow's model while contributing nothing is a lie about
    // what the next generation will do.
    act(() => {
      session?.publish({
        sourceId: "workflow-2",
        instanceId: "instance-2",
        nodes: [loaderNode("4", { classType: "LoraLoader", title: "Root loader" })],
        editableWidgets: [editableModelWidget("4")],
      });
    });

    expect(screen.getByLabelText("LoRA for Root loader")).toHaveValue(MODELS[0]);
    expect(
      collectContributions({ sourceId: "workflow-2", instanceId: "instance-2" })[0],
    ).toMatchObject({ bypassNodeIds: [], widgetOverrides: [], diagnostics: [] });

    // Going back to the first workflow restores its own choice: the selections
    // were scoped, not discarded.
    act(() => {
      session?.publish({
        ...WORKFLOW,
        nodes: GRAPH_NODES,
        editableWidgets: [editableModelWidget("4")],
      });
    });
    expect(screen.getByLabelText("LoRA for Root loader")).toHaveValue(MODELS[1]);
    expect(collectContributions()[0]).toMatchObject({
      widgetOverrides: [{ node_id: "4", widget: "lora_name", value: MODELS[1] }],
    });
  });

  it("keeps a choice made before the bridge reported the workflow instance", async () => {
    // A workflow with no source id is identified only by its ComfyUI instance,
    // and the bridge reports that after the panel mounts. A choice made in the
    // gap must survive identity *arriving*, which is not the same event as
    // identity changing.
    const unnamed = { sourceId: null, instanceId: null };
    await activateFixture([loaderNode("4", { title: "Root loader" })]);
    act(() => {
      session?.publish({
        ...unnamed,
        nodes: [loaderNode("4", { title: "Root loader" })],
        editableWidgets: [],
      });
    });
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", MODELS[1]);

    act(() => {
      session?.publish({
        sourceId: null,
        instanceId: "instance-late",
        nodes: [loaderNode("4", { title: "Root loader" })],
        editableWidgets: [],
      });
    });

    expect(screen.getByLabelText("LoRA for Root loader")).toHaveValue(MODELS[1]);
    expect(
      collectContributions({ sourceId: null, instanceId: "instance-late" })[0],
    ).toMatchObject({
      widgetOverrides: [{ node_id: "4", widget: "lora_name", value: MODELS[1] }],
    });

    // A *different* unnamed workflow is still a different workflow.
    act(() => {
      session?.publish({
        sourceId: null,
        instanceId: "instance-other",
        nodes: [loaderNode("4", { title: "Root loader" })],
        editableWidgets: [],
      });
    });
    expect(screen.getByLabelText("LoRA for Root loader")).toHaveValue(MODELS[0]);
    expect(
      collectContributions({ sourceId: null, instanceId: "instance-other" })[0],
    ).toMatchObject({ widgetOverrides: [] });
  });

  it("refuses a selection that would take the plan past what one contribution carries", async () => {
    const many = Array.from({ length: MAX_CONTRIBUTED_EFFECTS + 1 }, (_, index) =>
      loaderNode(`n${index}`, { title: `Loader ${index}` }),
    );
    await activateFixture(many);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    for (let index = 0; index < MAX_CONTRIBUTED_EFFECTS; index += 1) {
      selectModel(`Loader ${index}`, MODELS[1]);
    }
    selectModel(`Loader ${MAX_CONTRIBUTED_EFFECTS}`, MODELS[1]);

    // The host refuses an over-budget contribution whole, which would fail the
    // generation. The panel declines the selection instead, and says why.
    expect(screen.getByRole("status")).toHaveTextContent(
      `This workflow already has ${MAX_CONTRIBUTED_EFFECTS} loader changes planned`,
    );
    expect(
      screen.getByLabelText(`LoRA for Loader ${MAX_CONTRIBUTED_EFFECTS}`),
    ).toHaveValue(MODELS[0]);

    const group = collectContributions()[0];
    expect(group.widgetOverrides).toHaveLength(MAX_CONTRIBUTED_EFFECTS);
    expect(group.diagnostics).toEqual([]);
  });

  it("packs bypass targets into effects the host will accept", () => {
    // Bypasses are set-like, so a workflow with more loaders than one effect
    // may carry is a packing question, not a refusal: 300 bypassed loaders are
    // two effects, well inside the effect budget.
    const count = MAX_BYPASS_NODES_PER_EFFECT + 44;
    const nodes = Array.from({ length: count }, (_, index) =>
      loaderNode(`n${index}`, { title: `Loader ${index}` }),
    );
    const { session: snapshot } = projectGenerationSession({
      revision: 1,
      workflow: {
        ...WORKFLOW,
        revision: 1,
        fingerprint: "fingerprint-1",
        mode: "catalogue",
        nodes,
      },
      inputs: [],
      editableWidgets: [],
      readiness: { isLoading: false, isReady: true, hasError: false },
      submission: { isBusy: false, queuedCount: 0, canSubmit: true },
    });
    const selections = new Map(
      nodes.map((node) => [node.id, BYPASS_CHOICE] as const),
    );

    const effects = planLoaderEffects(snapshot, selections);

    expect(effects).toHaveLength(2);
    expect(effects.length).toBeLessThanOrEqual(MAX_CONTRIBUTED_EFFECTS);
    for (const effect of effects) {
      expect(effect.kind).toBe("bypass-nodes");
      if (effect.kind !== "bypass-nodes") continue;
      expect(effect.nodeIds.length).toBeLessThanOrEqual(
        MAX_BYPASS_NODES_PER_EFFECT,
      );
    }
    expect(
      effects.flatMap((effect) =>
        effect.kind === "bypass-nodes" ? [...effect.nodeIds] : [],
      ),
    ).toHaveLength(count);
  });

  it("applies root and scoped targets to the temporary clone only", async () => {
    await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    selectModel("Root loader", BYPASS_CHOICE);
    selectModel("Solo instance loader", MODELS[1]);

    const captured = captureGenerationEffectsForPlan(
      makePlan({ contributedEffects: collectContributions() }),
      new Set(),
      EXPECTATION,
    );
    expect(collectGenerationEffectErrors(captured)).toEqual([]);
    expect(captured.effects).toEqual([
      {
        kind: "bypass-nodes",
        nodeIds: ["4"],
        source: CONTRIBUTOR_SOURCE,
      },
      {
        kind: "set-widget",
        target: { nodeId: "12:6", widget: "lora_name" },
        value: MODELS[1],
        source: CONTRIBUTOR_SOURCE,
      },
    ]);

    const harness = createSubgraphHarness(loaderGraph());
    const response = await resolveScopedPrompt(
      harness,
      "policy-effects",
      buildBridgeEffectPayload(captured.effects),
    );
    const output = (response?.result as { output: Record<string, unknown> })
      .output;

    expect(response).toMatchObject({ ok: true });
    expect(output).not.toHaveProperty("4");
    expect(output).toMatchObject({
      "12:6": { inputs: { lora_name: MODELS[1] } },
      // The sibling instances share one definition node and must not move.
      "10:5": { inputs: { lora_name: MODELS[0] } },
      "11:5": { inputs: { lora_name: MODELS[0] } },
    });
    // Nothing outlives the resolution: the editor graph is exactly as it was.
    expect(liveNodeAt(harness, "4")?.mode).toBe(0);
    expect(liveNodeAt(harness, "12:6")?.widgets[0].value).toBe(MODELS[0]);
  });

  it("fails closed on a target shared by sibling instances", async () => {
    await activateFixture(GRAPH_NODES);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    selectModel("Shared instance A", MODELS[1]);

    const captured = captureGenerationEffectsForPlan(
      makePlan({ contributedEffects: collectContributions() }),
      new Set(),
      EXPECTATION,
    );
    // The host accepts the target — the workflow does contain `10:5` — and the
    // bridge is the owner that refuses it, before graphToPrompt runs.
    expect(collectGenerationEffectErrors(captured)).toEqual([]);

    const harness = createSubgraphHarness(loaderGraph());
    const response = await resolveScopedPrompt(
      harness,
      "shared-instance",
      buildBridgeEffectPayload(captured.effects),
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "graph-override-target-missing",
        details: {
          widgetOverrides: [
            { nodeId: "10:5", reason: "shared-subgraph-instance" },
          ],
        },
      },
    });
    expect(harness.app.graphToPrompt).not.toHaveBeenCalled();
    expect(liveNodeAt(harness, "10:5")?.widgets[0].value).toBe(MODELS[0]);
    expect(liveNodeAt(harness, "11:5")?.widgets[0].value).toBe(MODELS[0]);
  });

  it("drops a selection the current workflow revision no longer supports", async () => {
    await activateFixture(GRAPH_NODES);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);

    selectModel("Solo instance loader", MODELS[2]);
    selectModel("Shared instance A", MODELS[1]);

    // A new revision: one loader is gone, the other no longer offers the
    // chosen model. Contributing either would fail the user's whole
    // submission, so the fixture contributes neither.
    session?.publish({
      ...WORKFLOW,
      nodes: [
        loaderNode("10:5", {
          title: "Shared instance A",
          options: [MODELS[0]],
        }),
      ],
      editableWidgets: [],
    });

    expect(collectContributions()[0]).toMatchObject({
      bypassNodeIds: [],
      widgetOverrides: [],
      diagnostics: [],
    });
  });

  it("refuses to contribute to a submission planned against another workflow", async () => {
    await activateFixture(GRAPH_NODES);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Solo instance loader", MODELS[1]);

    const groups = collectContributions({
      sourceId: "workflow-2",
      instanceId: "instance-2",
    });

    expect(groups[0].widgetOverrides).toEqual([]);
    expect(groups[0].diagnostics).toEqual([
      {
        severity: "error",
        code: "contributor-failed",
        source: CONTRIBUTOR_SOURCE,
        message:
          `Contributor '${EXTENSION_ID}/policy' could not run: the mounted session ` +
          "describes a different workflow than this submission.",
      },
    ]);
  });

  it("lets the extension's choice win a collision, and records both sources", async () => {
    await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", MODELS[1]);

    const captured = captureGenerationEffectsForPlan(
      makePlan({
        contributedEffects: collectContributions(),
        workflowRules: {
          rewrites: [
            {
              when: { kind: "always" },
              set_widgets: [
                { node_id: "4", widget: "lora_name", value: MODELS[2] },
              ],
            },
          ],
        },
      }),
      new Set(),
      EXPECTATION,
    );

    expect(captured.effects).toEqual([
      {
        kind: "set-widget",
        target: { nodeId: "4", widget: "lora_name" },
        value: MODELS[1],
        source: CONTRIBUTOR_SOURCE,
      },
    ]);
    expect(captured.diagnostics).toEqual([
      {
        severity: "warning",
        code: "widget-collision",
        source: CONTRIBUTOR_SOURCE,
        message:
          "Widget 4.lora_name is written by both rule-rewrite and " +
          `${CONTRIBUTOR_SOURCE}; the ${CONTRIBUTOR_SOURCE} value wins`,
      },
    ]);
  });

  it("queues the contribution as plan data that outlives the extension", async () => {
    const host = await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", BYPASS_CHOICE);
    selectModel("Solo instance loader", MODELS[1]);

    // The real enqueue path: it collects from the registry once, validates the
    // contribution against the mounted session, and freezes the captured
    // effects into every plan in the batch before anything is dispatched.
    const harness = createQueueHarness();
    await harness.actions.queueGeneration({}, {}, {}, {}, 2);

    const queue = harness.state.generationQueue as readonly GenerationPlan[];
    expect(queue).toHaveLength(2);
    expect(queue[0].submission.contributedEffects).toEqual([
      {
        source: CONTRIBUTOR_SOURCE,
        workflow: {
          sourceId: WORKFLOW.sourceId,
          instanceId: WORKFLOW.instanceId,
          fingerprint: "fingerprint-1",
        },
        bypassNodeIds: ["4"],
        widgetOverrides: [
          { node_id: "12:6", widget: "lora_name", value: MODELS[1] },
        ],
        diagnostics: [],
      },
    ]);
    // One collection for the batch, cloned into each plan: a contributor asked
    // once per copy could have made the copies of one submission disagree.
    expect(queue[1].submission.contributedEffects).toEqual(
      queue[0].submission.contributedEffects,
    );
    const queuedEffects = queue[0].effects;
    expect(queuedEffects?.effects).toEqual([
      { kind: "bypass-nodes", nodeIds: ["4"], source: CONTRIBUTOR_SOURCE },
      {
        kind: "set-widget",
        target: { nodeId: "12:6", widget: "lora_name" },
        value: MODELS[1],
        source: CONTRIBUTOR_SOURCE,
      },
    ]);

    // Now take away everything the plan was built from.
    await host.deactivate(EXTENSION_ID);
    act(() => {
      session?.publish({
        sourceId: "workflow-2",
        instanceId: "instance-2",
        nodes: [SAMPLER_NODE],
        editableWidgets: [],
      });
    });

    expect(generationSubmissionContributors.size()).toBe(0);
    expect(harness.state.generationQueue).toBe(queue);
    expect(queue[0].effects).toBe(queuedEffects);
  });

  it("re-resolves a queued plan from its own data, not from the extension", async () => {
    const host = await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", MODELS[1]);
    selectModel("Solo instance loader", BYPASS_CHOICE);

    const plan = makePlan({ contributedEffects: collectContributions() });
    const queued = captureGenerationEffectsForPlan(plan, new Set(), EXPECTATION);

    await host.deactivate(EXTENSION_ID);
    session?.publish({
      ...WORKFLOW,
      nodes: [SAMPLER_NODE],
      editableWidgets: [],
    });

    // Dispatch re-captures after preprocessing, so this is the second capture
    // a queued plan gets. It reads plan data only: with the workflow switched
    // and the contributing package gone, it still resolves to the same bridge
    // payload, attributed to the extension that planned it. (That the queue
    // holds such a plan in the first place is the enqueue test above.)
    const dispatched = captureGenerationEffectsForPlan(
      plan,
      new Set(),
      EXPECTATION,
    );
    expect(bridgeEffectPayloadsMatch(queued, dispatched)).toBe(true);
    expect(dispatched.effects).toEqual(queued.effects);
    expect(
      dispatched.effects.every((effect) => effect.source === CONTRIBUTOR_SOURCE),
    ).toBe(true);
    expect(collectGenerationEffectErrors(dispatched)).toEqual([]);
  });

  it("removes the panel and the contributor when the extension unloads", async () => {
    const host = await activateFixture(GRAPH_NODES, [editableModelWidget("4")]);
    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    selectModel("Root loader", MODELS[1]);

    await host.deactivate(EXTENSION_ID);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(generationSubmissionContributors.size()).toBe(0);
    expect(collectContributions()).toEqual([]);
  });

  it("rolls back the panel and the contributor when activation fails", async () => {
    session = mountGenerationSession({ ...WORKFLOW, nodes: GRAPH_NODES });
    const host = createHost();
    const failing: ExtensionModule = {
      activate: (context) => {
        activate(context);
        throw new Error("activation failed after registering");
      },
    };

    await expect(
      host.activate({ id: EXTENSION_ID, version: "1.0.0" }, failing),
    ).rejects.toThrow(/activate extension/i);

    render(<ExtensionUiSlot slot="generation.inputs.after" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(generationSubmissionContributors.size()).toBe(0);
  });
});

describe("a contribution the host cannot honour", () => {
  const TAMPER_ID = "example.lora-policy-tamper";

  async function activateContributor(
    contribute: () => readonly never[],
  ): Promise<ExtensionHost<VloExtensionApi>> {
    session = mountGenerationSession({ ...WORKFLOW, nodes: GRAPH_NODES });
    const host = createHost();
    await host.activate(
      { id: TAMPER_ID, version: "1.0.0" },
      {
        activate: (context) => {
          context.api.generation.registerSubmissionContributor({
            id: "policy",
            apiVersion: 1,
            contribute,
          });
        },
      },
    );
    return host;
  }

  it("fails the submission when a contributed value is not on offer", async () => {
    await activateContributor(
      () =>
        [
          {
            kind: "set-widget",
            target: { nodeId: "12:6", widget: "lora_name" },
            value: "not-installed.safetensors",
          },
        ] as unknown as readonly never[],
    );

    const groups = collectContributions();
    expect(groups[0].widgetOverrides).toEqual([]);
    expect(groups[0].diagnostics).toMatchObject([
      { severity: "error", code: "invalid-value", source: `extension:${TAMPER_ID}/policy` },
    ]);

    // The error is replayed by every later capture, so an already queued plan
    // keeps failing rather than quietly dropping the effect.
    const captured = captureGenerationEffectsForPlan(
      makePlan({ contributedEffects: groups }),
      new Set(),
      EXPECTATION,
    );
    expect(collectGenerationEffectErrors(captured)).toHaveLength(1);
    expect(captured.effects).toEqual([]);
  });

  it("fails the submission when the contributor throws", async () => {
    await activateContributor(() => {
      throw new Error("provider exploded");
    });

    const groups = collectContributions();
    expect(groups[0]).toMatchObject({
      bypassNodeIds: [],
      widgetOverrides: [],
      diagnostics: [
        {
          severity: "error",
          code: "contributor-failed",
          source: `extension:${TAMPER_ID}/policy`,
        },
      ],
    });
    // The extension's own stack stays in its diagnostics; the host message
    // discloses nothing about it.
    expect(groups[0].diagnostics[0].message).not.toContain("provider exploded");
  });
});
