import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { mountGenerationSession } from "../../../../testUtils/generationSession";
import { createExtensionGenerationApi } from "../ExtensionGenerationBridge";

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.layout-prompt", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

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
    expect(
      api.transaction("After dispose", (transaction) => {
        transaction.setTextInput("6:text", "new");
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(session.commit).not.toHaveBeenCalled();
  });
});

describe("createExtensionGenerationApi without a mounted session", () => {
  it("reports the unmounted panel", () => {
    const api = createExtensionGenerationApi(createScope());
    expect(api.listInputs()).toEqual([]);
    expect(api.transaction("No session", () => undefined)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});
