import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { mountGenerationSession } from "../../../../testUtils/generationSession";
import { createExtensionGenerationApi } from "../ExtensionGenerationBridge";
import {
  GENERATION_SNAPSHOT_LIMITS,
  resetGenerationSessionProjectionCache,
} from "../generationSessionProjection";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationNodeSnapshot,
} from "../../../generation/services/generationSessionTypes";

function createScope(
  report: ExtensionApiScope["report"] = () => undefined,
): ExtensionApiScope {
  return {
    extension: { id: "example.layout-prompt", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

const loaderNodes: readonly GenerationNodeSnapshot[] = [
  {
    id: "10",
    classType: "LoraLoader",
    title: "Load LoRA",
    mode: 0,
    widgets: [
      {
        nodeId: "10",
        param: "lora_name",
        valueType: "enum",
        value: "sharp.safetensors",
        defaultValue: "sharp.safetensors",
        options: ["sharp.safetensors", "soft.safetensors"],
        min: null,
        max: null,
        step: null,
        linked: false,
        controlAfterGenerate: false,
      },
      {
        nodeId: "10",
        param: "strength_model",
        valueType: "float",
        value: 1,
        defaultValue: 1,
        options: null,
        min: 0,
        max: 2,
        step: 0.01,
        linked: false,
        controlAfterGenerate: false,
      },
    ],
  },
];

const loaderEditableWidgets: readonly GenerationEditableWidgetSnapshot[] = [
  {
    target: { nodeId: "10", widget: "lora_name" },
    valueType: "enum",
    value: "sharp.safetensors",
    options: ["sharp.safetensors", "soft.safetensors"],
    min: null,
    max: null,
    trueValue: null,
    falseValue: null,
  },
];

const inputs = [
  {
    id: "6:text",
    nodeId: "6",
    param: "text",
    label: "Prompt",
    inputType: "text" as const,
    value: "old",
  },
  {
    id: "7:image",
    nodeId: "7",
    param: "image",
    label: "Image",
    inputType: "image" as const,
  },
];

let activeUnmount: (() => void) | null = null;

beforeEach(() => {
  resetGenerationSessionProjectionCache();
});

afterEach(() => {
  activeUnmount?.();
  activeUnmount = null;
});

describe("ExtensionGenerationBridge", () => {
  it("commits validated text updates through one host write", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    expect(api.listInputs()).toHaveLength(2);
    expect(
      api.transaction("Apply layout prompt", (transaction) => {
        transaction.setTextInput("6:text", '{"regions":[]}');
      }),
    ).toEqual({ ok: true, changed: true, label: "Apply layout prompt" });
    expect(session.commit).toHaveBeenCalledOnce();
    expect([...session.commit.mock.calls[0][0].textInputs]).toEqual([
      ["6:text", '{"regions":[]}'],
    ]);
  });

  it("fails atomically for missing or non-text inputs", () => {
    const session = mountGenerationSession({ inputs: [inputs[1]] });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Wrong input", (transaction) => {
        transaction.setTextInput("7:image", "prompt");
      }),
    ).toMatchObject({ ok: false, code: "input_type_mismatch" });
    expect(
      api.transaction("Missing input", (transaction) => {
        transaction.setTextInput("missing", "prompt");
      }),
    ).toMatchObject({ ok: false, code: "input_not_found" });
    expect(session.commit).not.toHaveBeenCalled();

    session.unmount();
    activeUnmount = null;
    expect(api.transaction("Unavailable", () => undefined)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("rejects the whole transaction when one command is invalid", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Two writes", (transaction) => {
        transaction.setTextInput("6:text", "kept out");
        transaction.setTextInput("7:image", "not text");
      }),
    ).toMatchObject({ ok: false, code: "input_type_mismatch" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("keeps adapter-only limits out of the shared session", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Oversized", (transaction) => {
        transaction.setTextInput("6:text", "x".repeat(1_000_001));
      }),
    ).toMatchObject({ ok: false, code: "callback_failed" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("refuses asynchronous callbacks", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const asyncCallback = () => Promise.resolve();
    expect(
      api.transaction("Async", asyncCallback as unknown as () => void),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("reports an unchanged write without touching the host", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("No-op", (transaction) => {
        transaction.setTextInput("6:text", "old");
      }),
    ).toEqual({ ok: true, changed: false, label: "No-op" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("hands out detached input snapshots", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const [first] = api.listInputs();
    expect(() => {
      (first as { value: string }).value = "mutated";
    }).toThrow();
    expect(api.listInputs()[0].value).toBe("old");
  });

  it("stops answering once the activation is aborted", () => {
    const session = mountGenerationSession({ inputs });
    activeUnmount = session.unmount;
    const controller = new AbortController();
    const api = createExtensionGenerationApi({
      ...createScope(),
      signal: controller.signal,
    });

    controller.abort();
    expect(api.listInputs()).toEqual([]);
    expect(api.getSession()).toBeNull();
    expect(api.getRevision()).toBe(0);
    expect(
      api.transaction("After dispose", (transaction) => {
        transaction.setTextInput("6:text", "new");
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(session.commit).not.toHaveBeenCalled();
  });
});

describe("ExtensionGenerationBridge session reads", () => {
  it("projects the mounted workflow with its writable widgets marked", () => {
    const session = mountGenerationSession({
      inputs,
      nodes: loaderNodes,
      editableWidgets: loaderEditableWidgets,
    });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const snapshot = api.getSession();
    expect(snapshot).toMatchObject({
      status: "ready",
      canSubmit: true,
      busy: false,
      workflow: {
        sourceId: "workflow-1",
        instanceId: "instance-1",
        mode: "catalogue",
        fingerprint: "fingerprint-1",
      },
    });
    expect(snapshot?.inputs.map((input) => input.id)).toEqual([
      "6:text",
      "7:image",
    ]);

    const [loader] = snapshot?.workflow.nodes ?? [];
    expect(loader.classType).toBe("LoraLoader");
    expect(
      loader.widgets.map((widget) => [widget.param, widget.editable]),
    ).toEqual([
      ["lora_name", true],
      // Present in the graph but with no panel control: readable, and a write
      // will say so rather than silently missing the prompt.
      ["strength_model", false],
    ]);
    expect(loader.widgets[0].options).toEqual([
      "sharp.safetensors",
      "soft.safetensors",
    ]);
  });

  it("hands out a frozen snapshot that cannot reach host state", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const snapshot = api.getSession();
    expect(() => {
      (snapshot as unknown as { canSubmit: boolean }).canSubmit = false;
    }).toThrow();
    expect(() => {
      (snapshot?.workflow.nodes[0] as { title: string }).title = "mutated";
    }).toThrow();
    expect(api.getSession()?.workflow.nodes[0].title).toBe("Load LoRA");
  });

  it("keeps snapshot identity stable until the session changes", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const first = api.getSession();
    expect(api.getSession()).toBe(first);

    session.publish({
      nodes: loaderNodes,
      submission: { isBusy: true, queuedCount: 1, canSubmit: false },
    });
    const second = api.getSession();
    expect(second).not.toBe(first);
    expect(second?.busy).toBe(true);
    // The catalogue did not change, so a consumer memoizing on it does not
    // recompute for a submission-state change.
    expect(second?.workflow.nodes).toBe(first?.workflow.nodes);
  });

  it("separates the workflow revision from the session revision", () => {
    const session = mountGenerationSession({ nodes: loaderNodes, inputs });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());

    const before = api.getSession();
    const beforeRevision = api.getRevision();

    session.publish({
      nodes: loaderNodes,
      inputs: [{ ...inputs[0], value: "typed" }, inputs[1]],
    });
    expect(api.getRevision()).toBeGreaterThan(beforeRevision);
    expect(api.getSession()?.workflow.revision).toBe(
      before?.workflow.revision,
    );

    session.publish({ sourceId: "other.json", fingerprint: "fingerprint-2" });
    expect(api.getSession()?.workflow.revision).toBeGreaterThan(
      before?.workflow.revision ?? 0,
    );
  });

  it("notifies subscribers without a payload and stops when unsubscribed", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope());
    const listener = vi.fn();

    const unsubscribe = api.subscribe(listener);
    session.publish({ nodes: loaderNodes, inputs });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]).toEqual([]);

    unsubscribe();
    session.publish({ nodes: loaderNodes });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing subscriber and reports it on the owning scope", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    activeUnmount = session.unmount;
    const report = vi.fn();
    const api = createExtensionGenerationApi(createScope(report));

    api.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    const other = vi.fn();
    api.subscribe(other);

    expect(() => session.publish({ inputs })).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Generation session"),
      expect.any(Error),
    );
  });

  it("subscribes to nothing once the activation has ended", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    activeUnmount = session.unmount;
    const controller = new AbortController();
    const api = createExtensionGenerationApi({
      ...createScope(),
      signal: controller.signal,
    });
    controller.abort();

    const listener = vi.fn();
    api.subscribe(listener);
    session.publish({ inputs });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports a truncated catalogue once per revision", () => {
    const report = vi.fn();
    const options = Array.from(
      { length: GENERATION_SNAPSHOT_LIMITS.optionsPerWidget + 1 },
      (_unused, index) => `model-${index}.safetensors`,
    );
    const nodes: readonly GenerationNodeSnapshot[] = [
      { ...loaderNodes[0], widgets: [{ ...loaderNodes[0].widgets[0], options }] },
    ];
    const session = mountGenerationSession({ nodes });
    activeUnmount = session.unmount;
    const api = createExtensionGenerationApi(createScope(report));

    expect(api.getSession()?.workflow.nodes[0].widgets[0].options).toHaveLength(
      GENERATION_SNAPSHOT_LIMITS.optionsPerWidget,
    );
    api.getSession();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("truncated"),
      expect.arrayContaining([expect.stringContaining("options")]),
    );
  });
});

describe("ExtensionGenerationBridge widget writes", () => {
  function mountLoader() {
    const session = mountGenerationSession({
      inputs,
      nodes: loaderNodes,
      editableWidgets: loaderEditableWidgets,
    });
    activeUnmount = session.unmount;
    return session;
  }

  it("commits a validated widget write through the shared session", () => {
    const session = mountLoader();
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Choose model", (transaction) => {
        transaction.setWidget(
          { nodeId: "10", widget: "lora_name" },
          "soft.safetensors",
        );
      }),
    ).toEqual({ ok: true, changed: true, label: "Choose model" });
    expect(session.commit.mock.calls[0][0].widgets).toEqual([
      {
        target: { nodeId: "10", widget: "lora_name" },
        value: "soft.safetensors",
      },
    ]);
  });

  it("distinguishes the three ways a widget write can be refused", () => {
    const session = mountLoader();
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Missing widget", (transaction) => {
        transaction.setWidget({ nodeId: "10", widget: "nope" }, "x");
      }),
    ).toMatchObject({ ok: false, code: "widget_not_found" });
    expect(
      api.transaction("No control", (transaction) => {
        transaction.setWidget({ nodeId: "10", widget: "strength_model" }, 0.5);
      }),
    ).toMatchObject({ ok: false, code: "widget_not_editable" });
    expect(
      api.transaction("Not an option", (transaction) => {
        transaction.setWidget(
          { nodeId: "10", widget: "lora_name" },
          "absent.safetensors",
        );
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("fails the whole transaction when a mixed write is invalid", () => {
    const session = mountLoader();
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Text and widget", (transaction) => {
        transaction.setTextInput("6:text", "kept out");
        transaction.setWidget(
          { nodeId: "10", widget: "lora_name" },
          "absent.safetensors",
        );
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(session.commit).not.toHaveBeenCalled();
  });

  it("keeps adapter-only widget limits out of the shared session", () => {
    const session = mountLoader();
    const api = createExtensionGenerationApi(createScope());

    expect(
      api.transaction("Oversized value", (transaction) => {
        transaction.setWidget(
          { nodeId: "10", widget: "lora_name" },
          "x".repeat(200_000),
        );
      }),
    ).toMatchObject({ ok: false, code: "callback_failed" });
    expect(
      api.transaction("Non-finite value", (transaction) => {
        transaction.setWidget(
          { nodeId: "10", widget: "lora_name" },
          Number.POSITIVE_INFINITY as never,
        );
      }),
    ).toMatchObject({ ok: false, code: "callback_failed" });
    expect(
      api.transaction("Malformed target", (transaction) => {
        transaction.setWidget(
          { nodeId: "", widget: "lora_name" },
          "soft.safetensors",
        );
      }),
    ).toMatchObject({ ok: false, code: "callback_failed" });
    expect(session.commit).not.toHaveBeenCalled();
  });
});

describe("createExtensionGenerationApi without a mounted session", () => {
  it("reports the unmounted panel", () => {
    const api = createExtensionGenerationApi(createScope());
    expect(api.listInputs()).toEqual([]);
    expect(api.getSession()).toBeNull();
    expect(api.transaction("No session", () => undefined)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("drops the snapshot when the panel unmounts", () => {
    const session = mountGenerationSession({ nodes: loaderNodes });
    const api = createExtensionGenerationApi(createScope());
    const listener = vi.fn();
    api.subscribe(listener);
    expect(api.getSession()).not.toBeNull();

    session.unmount();
    expect(listener).toHaveBeenCalled();
    expect(api.getSession()).toBeNull();
  });
});
