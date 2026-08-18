import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionGenerationApi,
  PUBLIC_FAILURE_CODES,
} from "../../../extensions/generation/ExtensionGenerationBridge";
import type { ExtensionApiScope, ExtensionResource } from "../../../extensions";
import { generationSessionService } from "../../services/GenerationSessionService";
import type {
  GenerationTransactionFailureCode,
  GenerationTransactionResult,
} from "../../services/generationSessionTypes";
import { createGenerationPublication } from "../../../../testUtils/generationSession";
import { useGenerationStore } from "../../useGenerationStore";
import { resetZustandStore } from "../../../../testUtils/zustand";
import type {
  GenerationJob,
  WorkflowInput,
  WorkflowWidgetInput,
} from "../../types";
import { useGenerationSessionMount } from "../useGenerationSessionMount";

/**
 * The N2 pairing gate: the panel's own controls and the extension text-input
 * entry point must reach state through the same session transaction.
 */

const workflowInputs: WorkflowInput[] = [
  {
    nodeId: "6",
    classType: "CLIPTextEncode",
    inputType: "text",
    param: "text",
    label: "Prompt",
    currentValue: "",
    origin: "rule",
  },
];

const widgetInputs: WorkflowWidgetInput[] = [
  {
    nodeId: "3",
    param: "steps",
    currentValue: 20,
    config: {
      label: "Steps",
      controlAfterGenerate: false,
      valueType: "int",
      min: 1,
      max: 100,
    },
  },
];

function makeJob(status: GenerationJob["status"]): GenerationJob {
  return {
    id: "job-1",
    status,
    progress: 0,
    currentNode: null,
    outputs: [],
    error: status === "error" ? "submission failed" : null,
    submittedAt: 0,
    completedAt: status === "error" ? 1 : null,
  };
}

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.layout-prompt", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

function mountPanelSession(
  overrides: Partial<Parameters<typeof useGenerationSessionMount>[0]> = {},
) {
  const commitTextInputs = vi.fn();
  const applyWidgetValue = vi.fn();
  const rendered = renderHook(() =>
    useGenerationSessionMount({
      workflowInputs,
      textValues: { "6:text": "old prompt" },
      widgetInputs,
      widgetValues: {},
      selectedWorkflowId: "wf.json",
      hasWorkflowError: false,
      canSubmit: true,
      commitTextInputs,
      applyWidgetValue,
      ...overrides,
    }),
  );
  return { ...rendered, commitTextInputs, applyWidgetValue };
}

beforeEach(() => {
  useGenerationStore.setState({
    syncedWorkflow: {
      "3": { class_type: "KSampler", inputs: { steps: 20 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "old prompt" } },
    },
    syncedGraphData: { nodes: [] },
    rawObjectInfo: null,
    iframeWorkflowInstanceId: "instance-1",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetZustandStore(useGenerationStore);
});

describe("useGenerationSessionMount", () => {
  it("publishes a reactive snapshot of the mounted workflow", () => {
    const { rerender, unmount } = mountPanelSession();

    const snapshot = generationSessionService.getSnapshot();
    expect(snapshot?.workflow).toMatchObject({
      sourceId: "wf.json",
      instanceId: "instance-1",
      mode: "catalogue",
      revision: 1,
    });
    expect(
      snapshot?.workflow.nodes.map((node) => node.id).sort(),
    ).toEqual(["3", "6"]);
    expect(snapshot?.inputs).toEqual([
      expect.objectContaining({ id: "6:text", value: "old prompt" }),
    ]);
    expect(snapshot?.editableWidgets).toEqual([
      expect.objectContaining({
        target: { nodeId: "3", widget: "steps" },
        value: 20,
      }),
    ]);

    // A panel value change republishes without re-identifying the workflow.
    rerender();
    act(() => {
      useGenerationStore.setState({ iframeWorkflowInstanceId: "instance-2" });
    });
    expect(generationSessionService.getSnapshot()?.workflow.revision).toBe(2);

    unmount();
    expect(generationSessionService.getSnapshot()).toBeNull();
  });

  it("reports submission busy by job status, not by an installed active job", () => {
    mountPanelSession();
    expect(
      generationSessionService.getSnapshot()?.submission.isBusy,
    ).toBe(false);

    act(() => {
      useGenerationStore.setState({
        activeJobId: "job-1",
        jobs: new Map([["job-1", makeJob("running")]]),
      });
    });
    expect(generationSessionService.getSnapshot()?.submission.isBusy).toBe(true);

    // A failed submission leaves the errored job installed as the active one.
    // Nothing is in flight any more, so the session must not stay busy.
    act(() => {
      useGenerationStore.setState({
        jobs: new Map([["job-1", makeJob("error")]]),
      });
    });
    expect(
      generationSessionService.getSnapshot()?.submission.isBusy,
    ).toBe(false);
  });

  it("routes native widget and text writes through the session", () => {
    const { result, commitTextInputs, applyWidgetValue } = mountPanelSession();

    act(() => {
      result.current.commitWidgetValue("3", "steps", 35);
      result.current.commitTextValue("6:text", "new prompt");
    });

    expect(applyWidgetValue).toHaveBeenCalledWith("3", "steps", 35);
    expect([...commitTextInputs.mock.calls[0][0]]).toEqual([
      ["6:text", "new prompt"],
    ]);
  });

  it("refuses a native write the mounted workflow cannot accept", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, applyWidgetValue } = mountPanelSession();

    let outcome: ReturnType<typeof result.current.commitWidgetValue> | null =
      null;
    act(() => {
      outcome = result.current.commitWidgetValue("3", "steps", 500);
    });

    expect(outcome).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(applyWidgetValue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("gives the extension text-input entry point the same session", () => {
    const { commitTextInputs, applyWidgetValue } = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());

    expect(api.listInputs()).toEqual([
      expect.objectContaining({ id: "6:text", value: "old prompt" }),
    ]);
    expect(
      api.transaction("Apply layout prompt", (transaction) => {
        transaction.setTextInput("6:text", '{"regions":[]}');
      }),
    ).toMatchObject({ ok: true, changed: true });

    expect([...commitTextInputs.mock.calls[0][0]]).toEqual([
      ["6:text", '{"regions":[]}'],
    ]);
    expect(applyWidgetValue).not.toHaveBeenCalled();
  });

  it("leaves the panel writable after the extension entry point fails", () => {
    const { result, commitTextInputs } = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Missing input", (transaction) => {
        transaction.setTextInput("nope", "value");
      }),
    ).toMatchObject({ ok: false, code: "input_not_found" });
    expect(commitTextInputs).not.toHaveBeenCalled();

    act(() => {
      result.current.commitTextValue("6:text", "typed by hand");
    });
    expect([...commitTextInputs.mock.calls[0][0]]).toEqual([
      ["6:text", "typed by hand"],
    ]);
  });
});

/**
 * The N3 boundary gate
 * (docs/generation-native-extension-seams-plan.md §5, N3).
 *
 * N2 proved the two entry points reach the *same* session. What a published SDK
 * surface additionally needs is that they behave the same through it: the same
 * write must produce the same host commit and the same outcome, and every host
 * failure code must have a pinned public translation. The failure map is the
 * part that drifts silently — a host code added without a mapping entry would
 * otherwise reach an extension as `undefined`.
 */
describe("native and extension entry points agree", () => {
  it("produces the same host commit and outcome for the same write", () => {
    const native = mountPanelSession();
    let nativeOutcome: GenerationTransactionResult | null = null;
    act(() => {
      nativeOutcome = native.result.current.commitTextValue("6:text", "shared");
    });
    const nativeCommit = [...native.commitTextInputs.mock.calls[0][0]];
    native.unmount();

    const viaExtension = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());
    const extensionOutcome = api.transaction("Shared write", (transaction) => {
      transaction.setTextInput("6:text", "shared");
    });
    const extensionCommit = [
      ...viaExtension.commitTextInputs.mock.calls[0][0],
    ];

    expect(extensionCommit).toEqual(nativeCommit);
    expect(extensionCommit).toEqual([["6:text", "shared"]]);
    // The public result drops the host's `code` on success but must agree on
    // whether anything changed — an extension gates its own work on it.
    expect(nativeOutcome).toMatchObject({ ok: true, changed: true });
    expect(extensionOutcome).toMatchObject({ ok: true, changed: true });
  });

  it("agrees that a write matching the current value changed nothing", () => {
    const native = mountPanelSession();
    let nativeOutcome: GenerationTransactionResult | null = null;
    act(() => {
      nativeOutcome = native.result.current.commitTextValue(
        "6:text",
        "old prompt",
      );
    });
    expect(native.commitTextInputs).not.toHaveBeenCalled();
    native.unmount();

    const viaExtension = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());
    const extensionOutcome = api.transaction("No-op write", (transaction) => {
      transaction.setTextInput("6:text", "old prompt");
    });

    expect(nativeOutcome).toMatchObject({ ok: true, changed: false });
    expect(extensionOutcome).toMatchObject({ ok: true, changed: false });
    expect(viaExtension.commitTextInputs).not.toHaveBeenCalled();
  });

  it("pins the published translation of every host failure code", () => {
    // Assignment against the host union: a code added to
    // GenerationTransactionFailureCode without an entry here fails to compile,
    // and one removed leaves a stale key behind.
    const expected: Record<GenerationTransactionFailureCode, string> = {
      invalid_label: "invalid_label",
      unavailable: "unavailable",
      // A workflow switch under the callback leaves the session the extension
      // addressed unreachable, which is what `unavailable` means publicly.
      workflow_changed: "unavailable",
      invalid_command: "invalid_command",
      callback_failed: "callback_failed",
      input_not_found: "input_not_found",
      input_type_mismatch: "input_type_mismatch",
      // Published as themselves since E1: with `setWidget` on the surface, an
      // extension has to be able to tell "no such widget" from "no control for
      // it" from "bad value" to decide whether to fall back.
      widget_not_found: "widget_not_found",
      widget_not_editable: "widget_not_editable",
      widget_value_invalid: "widget_value_invalid",
    };
    expect(PUBLIC_FAILURE_CODES).toEqual(expected);
  });

  it("reports the same host rejection through both entry points", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = mountPanelSession();
    let nativeOutcome: GenerationTransactionResult | null = null;
    act(() => {
      nativeOutcome = native.result.current.commitTextValue("nope", "value");
    });
    native.unmount();

    const viaExtension = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());
    const extensionOutcome = api.transaction("Missing input", (transaction) => {
      transaction.setTextInput("nope", "value");
    });

    expect(nativeOutcome).toMatchObject({ ok: false, code: "input_not_found" });
    expect(extensionOutcome).toMatchObject({
      ok: false,
      code: PUBLIC_FAILURE_CODES.input_not_found,
    });
    expect(viaExtension.commitTextInputs).not.toHaveBeenCalled();
  });

  it("translates a mid-callback workflow switch to the published code", () => {
    const { commitTextInputs } = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());

    const outcome = api.transaction("Racing write", (transaction) => {
      transaction.setTextInput("6:text", "value");
      // Arbitrary extension code runs here; a workflow switch under it must
      // never let the staged write land on the workflow that replaced it.
      generationSessionService.publish(
        createGenerationPublication({
          sourceId: "other.json",
          fingerprint: "fingerprint-2",
        }),
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: PUBLIC_FAILURE_CODES.workflow_changed,
    });
    expect(outcome).toMatchObject({ code: "unavailable" });
    expect(commitTextInputs).not.toHaveBeenCalled();
  });
  it("produces the same host write for a native and an extension widget edit", () => {
    const native = mountPanelSession();
    let nativeOutcome: GenerationTransactionResult | null = null;
    act(() => {
      nativeOutcome = native.result.current.commitWidgetValue("3", "steps", 35);
    });
    const nativeCall = native.applyWidgetValue.mock.calls[0];
    native.unmount();

    const viaExtension = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());
    const extensionOutcome = api.transaction("Set steps", (transaction) => {
      transaction.setWidget({ nodeId: "3", widget: "steps" }, 35);
    });

    expect(viaExtension.applyWidgetValue.mock.calls[0]).toEqual(nativeCall);
    expect(nativeOutcome).toMatchObject({ ok: true, changed: true });
    expect(extensionOutcome).toMatchObject({ ok: true, changed: true });
  });

  it("refuses the same out-of-range widget write on both paths", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = mountPanelSession();
    let nativeOutcome: GenerationTransactionResult | null = null;
    act(() => {
      nativeOutcome = native.result.current.commitWidgetValue("3", "steps", 500);
    });
    native.unmount();

    const viaExtension = mountPanelSession();
    const api = createExtensionGenerationApi(createScope());
    const extensionOutcome = api.transaction("Too many steps", (transaction) => {
      transaction.setWidget({ nodeId: "3", widget: "steps" }, 500);
    });

    expect(nativeOutcome).toMatchObject({
      ok: false,
      code: "widget_value_invalid",
    });
    expect(extensionOutcome).toMatchObject({
      ok: false,
      code: PUBLIC_FAILURE_CODES.widget_value_invalid,
    });
    expect(viaExtension.applyWidgetValue).not.toHaveBeenCalled();
  });

  it("projects the panel's own session state to the extension surface", () => {
    useGenerationStore.setState({ isWorkflowReady: true });
    mountPanelSession();
    const api = createExtensionGenerationApi(createScope());

    const session = api.getSession();
    expect(session).toMatchObject({ status: "ready", canSubmit: true });
    expect(session?.workflow).toMatchObject({
      sourceId: "wf.json",
      instanceId: "instance-1",
      mode: "catalogue",
    });
    // The catalogue the panel built, with the panel's binding marking which of
    // it is writable.
    const steps = session?.workflow.nodes
      .find((node) => node.id === "3")
      ?.widgets.find((widget) => widget.param === "steps");
    expect(steps).toMatchObject({
      valueType: "int",
      min: 1,
      max: 100,
      editable: true,
    });
  });

  it("says the panel cannot submit when the panel's own gate is closed", () => {
    mountPanelSession({ canSubmit: false });
    const api = createExtensionGenerationApi(createScope());
    expect(api.getSession()?.canSubmit).toBe(false);
  });

  it("reports a failed workflow load as an error rather than as loading", () => {
    mountPanelSession({ hasWorkflowError: true });
    const api = createExtensionGenerationApi(createScope());
    expect(api.getSession()?.status).toBe("error");
  });
});
