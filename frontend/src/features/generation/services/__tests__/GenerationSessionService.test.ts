import { describe, expect, it, vi } from "vitest";
import { GenerationSessionService } from "../GenerationSessionService";
import type {
  GenerationEditableWidgetSnapshot,
  GenerationInputSnapshot,
  GenerationNodeSnapshot,
  GenerationSessionCommit,
  GenerationSessionPublication,
} from "../generationSessionTypes";

function textInput(
  overrides: Partial<GenerationInputSnapshot> = {},
): GenerationInputSnapshot {
  return {
    id: "6:text",
    nodeId: "6",
    param: "text",
    label: "Prompt",
    inputType: "text",
    value: "old",
    ...overrides,
  };
}

function editableWidget(
  overrides: Partial<GenerationEditableWidgetSnapshot> = {},
): GenerationEditableWidgetSnapshot {
  return {
    target: { nodeId: "3", widget: "steps" },
    valueType: "int",
    value: 20,
    options: null,
    min: 1,
    max: 100,
    trueValue: null,
    falseValue: null,
    ...overrides,
  };
}

// Shared identity: the service treats a fresh node array as a catalogue
// rebuild, and the panel memoizes it for the same reason.
const EMPTY_NODES: readonly GenerationNodeSnapshot[] = [];

function publication(
  overrides: Partial<GenerationSessionPublication> = {},
): GenerationSessionPublication {
  return {
    sourceId: "workflow-1",
    instanceId: "instance-1",
    fingerprint: "fingerprint-1",
    mode: "catalogue",
    nodes: EMPTY_NODES,
    inputs: [textInput()],
    editableWidgets: [editableWidget()],
    readiness: { isLoading: false, isReady: true, hasError: false },
    submission: { isBusy: false, queuedCount: 0, canSubmit: true },
    ...overrides,
  };
}

function mount(overrides: Partial<GenerationSessionPublication> = {}) {
  const service = new GenerationSessionService();
  const commit = vi.fn<(update: GenerationSessionCommit) => void>();
  const unmount = service.mount({ commit });
  service.publish(publication(overrides));
  return { service, commit, unmount };
}

describe("GenerationSessionService lifecycle", () => {
  it("only serves a snapshot between mount and unmount", () => {
    const service = new GenerationSessionService();
    expect(service.getSnapshot()).toBeNull();

    // A publication before mounting is ignored rather than queued.
    service.publish(publication());
    expect(service.getSnapshot()).toBeNull();

    const unmount = service.mount({ commit: vi.fn() });
    service.publish(publication());
    expect(service.getSnapshot()?.workflow.sourceId).toBe("workflow-1");

    unmount();
    expect(service.getSnapshot()).toBeNull();
    expect(
      service.transaction("After unmount", (transaction) => {
        transaction.setTextInput("6:text", "new");
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("notifies subscribers on publish and on unmount, without a payload", () => {
    const service = new GenerationSessionService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    const unmount = service.mount({ commit: vi.fn() });

    service.publish(publication());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]).toEqual([]);

    // An identical publication is not a change.
    service.publish(publication());
    expect(listener).toHaveBeenCalledTimes(1);

    service.publish(publication({ inputs: [textInput({ value: "typed" })] }));
    expect(listener).toHaveBeenCalledTimes(2);

    const revisionBeforeUnmount = service.getRevision();
    unmount();
    expect(listener).toHaveBeenCalledTimes(3);
    // A `useSyncExternalStore` consumer re-reads `getRevision` on notify and
    // must see a different value, or it keeps rendering the dead session.
    expect(service.getRevision()).not.toBe(revisionBeforeUnmount);

    unsubscribe();
    service.mount({ commit: vi.fn() });
    service.publish(publication());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("bumps the session revision on every change and the workflow revision only on workflow changes", () => {
    const { service } = mount();
    const first = service.getSnapshot();
    expect(first?.revision).toBe(1);
    expect(first?.workflow.revision).toBe(1);

    service.publish(publication({ inputs: [textInput({ value: "typed" })] }));
    const second = service.getSnapshot();
    expect(second?.revision).toBe(2);
    expect(second?.workflow.revision).toBe(1);
    expect(service.getRevision()).toBe(2);

    service.publish(
      publication({
        sourceId: "workflow-2",
        fingerprint: "fingerprint-2",
      }),
    );
    const third = service.getSnapshot();
    expect(third?.revision).toBe(3);
    expect(third?.workflow.revision).toBe(2);
  });

  it("republishes when a widget's constraints change but its value does not", () => {
    const { service } = mount();
    const before = service.getRevision();

    service.publish(
      publication({
        editableWidgets: [
          editableWidget({
            valueType: "boolean",
            value: 20,
            trueValue: "on",
            falseValue: "off",
          }),
        ],
      }),
    );

    // Validation reads these, so a stale snapshot would keep judging writes
    // against the previous mapping.
    expect(service.getRevision()).not.toBe(before);
    expect(service.getSnapshot()?.editableWidgets[0]).toMatchObject({
      trueValue: "on",
      falseValue: "off",
    });
  });

  it("does not republish for a value-equal options array", () => {
    const { service } = mount({
      editableWidgets: [
        editableWidget({
          valueType: "enum",
          value: "euler",
          options: ["euler", "dpmpp_2m"],
        }),
      ],
    });
    const before = service.getRevision();

    service.publish(
      publication({
        editableWidgets: [
          editableWidget({
            valueType: "enum",
            value: "euler",
            options: ["euler", "dpmpp_2m"],
          }),
        ],
      }),
    );

    expect(service.getRevision()).toBe(before);
  });

  it("hands out frozen snapshots", () => {
    const { service } = mount();
    const snapshot = service.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.workflow)).toBe(true);
    expect(() => {
      (snapshot as unknown as { revision: number }).revision = 99;
    }).toThrow();
  });
});

describe("GenerationSessionService transactions", () => {
  it("commits text and widget writes in a single host write", () => {
    const { service, commit } = mount();

    const result = service.transaction("Apply preset", (transaction) => {
      transaction.setTextInput("6:text", "new prompt");
      transaction.setWidget({ nodeId: "3", widget: "steps" }, 32);
    });

    expect(result).toEqual({ ok: true, changed: true, label: "Apply preset" });
    expect(commit).toHaveBeenCalledOnce();
    const update = commit.mock.calls[0][0];
    expect([...update.textInputs]).toEqual([["6:text", "new prompt"]]);
    expect(update.widgets).toEqual([
      { target: { nodeId: "3", widget: "steps" }, value: 32 },
    ]);
  });

  it("applies nothing when any command in the transaction fails", () => {
    const { service, commit } = mount();

    expect(
      service.transaction("Mixed", (transaction) => {
        transaction.setTextInput("6:text", "new prompt");
        transaction.setWidget({ nodeId: "3", widget: "steps" }, 5_000);
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a target the same workflow stopped exposing", () => {
    const { service, commit } = mount();

    // Same workflow, so the identity pin says nothing; the control simply went
    // away under the callback (a rules section hiding it, say).
    const result = service.transaction("Slow callback", (transaction) => {
      service.publish(publication({ inputs: [], editableWidgets: [] }));
      transaction.setTextInput("6:text", "new prompt");
    });

    expect(result).toMatchObject({ ok: false, code: "input_not_found" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses to land on a different workflow that reuses the same ids", () => {
    const { service, commit } = mount();

    const result = service.transaction("Slow callback", (transaction) => {
      // The replacement workflow has an identically addressed input and
      // widget. Nothing about the commands looks stale — only the workflow
      // identity says this write was staged against something else.
      service.publish(
        publication({ sourceId: "workflow-2", fingerprint: "fingerprint-2" }),
      );
      transaction.setTextInput("6:text", "new prompt");
      transaction.setWidget({ nodeId: "3", widget: "steps" }, 40);
    });

    expect(result).toMatchObject({ ok: false, code: "workflow_changed" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("survives an unmount inside the callback", () => {
    const { service, commit, unmount } = mount();

    expect(
      service.transaction("Unmounting callback", (transaction) => {
        unmount();
        transaction.setTextInput("6:text", "new prompt");
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("never commits through a host the callback replaced", () => {
    const { service, commit, unmount } = mount();
    const replacementCommit = vi.fn();

    const result = service.transaction("Remounting callback", (transaction) => {
      unmount();
      service.mount({ commit: replacementCommit });
      service.publish(publication());
      transaction.setTextInput("6:text", "new prompt");
    });

    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(commit).not.toHaveBeenCalled();
    expect(replacementCommit).not.toHaveBeenCalled();
  });

  it("separates an unknown widget from one the panel cannot edit", () => {
    const { service } = mount({
      nodes: [
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
              value: "a.safetensors",
              defaultValue: null,
              options: ["a.safetensors"],
              min: null,
              max: null,
              step: null,
              linked: false,
              controlAfterGenerate: false,
            },
          ],
        },
      ],
    });

    expect(
      service.transaction("Catalogue only", (transaction) => {
        transaction.setWidget({ nodeId: "10", widget: "lora_name" }, "a.safetensors");
      }),
    ).toMatchObject({ ok: false, code: "widget_not_editable" });

    expect(
      service.transaction("Unknown", (transaction) => {
        transaction.setWidget({ nodeId: "999", widget: "steps" }, 4);
      }),
    ).toMatchObject({ ok: false, code: "widget_not_found" });
  });

  it("validates enum options and numeric ranges", () => {
    const { service, commit } = mount({
      editableWidgets: [
        editableWidget(),
        editableWidget({
          target: { nodeId: "3", widget: "sampler_name" },
          valueType: "enum",
          value: "euler",
          options: ["euler", "dpmpp_2m"],
          min: null,
          max: null,
        }),
        editableWidget({
          target: { nodeId: "3", widget: "denoise" },
          valueType: "float",
          value: 1,
          min: 0,
          max: 1,
        }),
      ],
    });

    expect(
      service.transaction("Bad option", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "sampler_name" }, "ddim");
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(
      service.transaction("Fractional int", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "steps" }, 12.5);
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(
      service.transaction("Above max", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "denoise" }, 1.5);
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(
      service.transaction("Not finite JSON", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "steps" }, Number.NaN);
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(commit).not.toHaveBeenCalled();

    expect(
      service.transaction("Valid", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "sampler_name" }, "dpmpp_2m");
        transaction.setWidget({ nodeId: "3", widget: "denoise" }, 0.65);
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("accepts the in-progress text a numeric panel field emits", () => {
    const { service, commit } = mount({
      editableWidgets: [
        editableWidget({
          target: { nodeId: "3", widget: "seed" },
          valueType: "int",
          value: 12,
          min: 0,
          // Seed range ComfyUI publishes (2^64); values beyond 2^53 stay
          // strings so their precision survives the round trip.
          max: 2 ** 64,
        }),
      ],
    });

    for (const value of ["", "42", "9007199254740993"]) {
      expect(
        service.transaction("Typing", (transaction) => {
          transaction.setWidget({ nodeId: "3", widget: "seed" }, value);
        }),
      ).toMatchObject({ ok: true });
    }
    expect(commit).toHaveBeenCalledTimes(3);

    expect(
      service.transaction("Nonsense", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "seed" }, "12abc");
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });

    // Text that overflows to an infinity is not a large seed, it is an
    // unrepresentable one — and an infinity is neither inside nor outside a
    // finite bound, so it would otherwise skip the range check entirely.
    expect(
      service.transaction("Overflowing", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "seed" }, "1e9999");
      }),
    ).toMatchObject({ ok: false, code: "widget_value_invalid" });
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it("keeps the last write to a target and reports a no-op text write", () => {
    const { service, commit } = mount();

    expect(
      service.transaction("Last write wins", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "steps" }, 30);
        transaction.setWidget({ nodeId: "3", widget: "steps" }, 40);
      }),
    ).toMatchObject({ ok: true });
    expect(commit.mock.calls[0][0].widgets).toEqual([
      { target: { nodeId: "3", widget: "steps" }, value: 40 },
    ]);

    commit.mockClear();
    expect(
      service.transaction("Unchanged text", (transaction) => {
        transaction.setTextInput("6:text", "old");
      }),
    ).toEqual({ ok: true, changed: false, label: "Unchanged text" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("still commits a widget write the snapshot already shows", () => {
    // The panel owns the live value and dedupes there; the snapshot can trail
    // a keystroke by a render, so a matching value must not be dropped here.
    const { service, commit } = mount();

    expect(
      service.transaction("Same value", (transaction) => {
        transaction.setWidget({ nodeId: "3", widget: "steps" }, 20);
      }),
    ).toEqual({ ok: true, changed: false, label: "Same value" });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("resolves the bare node id a panel control addresses an input by", () => {
    const { service, commit } = mount();

    expect(
      service.transaction("Alias", (transaction) => {
        transaction.setTextInput("6", "new prompt");
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect([...commit.mock.calls[0][0].textInputs]).toEqual([
      ["6:text", "new prompt"],
    ]);
  });

  it("refuses ambiguous aliases, empty labels, and closed transactions", () => {
    const { service, commit } = mount({
      inputs: [
        textInput(),
        textInput({ id: "6:text2", param: "text2", value: "other" }),
      ],
    });

    expect(
      service.transaction("Ambiguous", (transaction) => {
        transaction.setTextInput("6", "new prompt");
      }),
    ).toMatchObject({ ok: false, code: "input_not_found" });
    expect(service.transaction("   ", () => undefined)).toMatchObject({
      ok: false,
      code: "invalid_label",
    });

    let escaped: { setTextInput: (id: string, value: string) => void } | null =
      null;
    service.transaction("Escape", (transaction) => {
      escaped = transaction;
    });
    expect(() => escaped?.setTextInput("6:text", "late")).toThrow(
      "The generation transaction is closed.",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports a throwing callback without committing", () => {
    const { service, commit } = mount();

    expect(
      service.transaction("Throwing", (transaction) => {
        transaction.setTextInput("6:text", "new prompt");
        throw new Error("extension bug");
      }),
    ).toMatchObject({ ok: false, code: "callback_failed", message: "extension bug" });
    expect(commit).not.toHaveBeenCalled();
  });
});
