import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import {
  createExtensionGenerationApi,
  extensionGenerationBridge,
} from "../ExtensionGenerationBridge";

function createScope(): ExtensionApiScope {
  return {
    extension: { id: "example.layout-prompt", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

describe("ExtensionGenerationBridge", () => {
  it("commits validated text updates through one host write", () => {
    const commitTextInputs = vi.fn();
    const unmount = extensionGenerationBridge.mount({
      listInputs: () => [
        {
          id: "6:text",
          nodeId: "6",
          param: "text",
          label: "Prompt",
          inputType: "text",
          value: "old",
        },
        {
          id: "7:image",
          nodeId: "7",
          param: "image",
          label: "Image",
          inputType: "image",
        },
      ],
      commitTextInputs,
    });
    const api = createExtensionGenerationApi(createScope());

    expect(api.listInputs()).toHaveLength(2);
    expect(
      api.transaction("Apply layout prompt", (transaction) => {
        transaction.setTextInput("6:text", '{"regions":[]}');
      }),
    ).toEqual({ ok: true, changed: true, label: "Apply layout prompt" });
    expect(commitTextInputs).toHaveBeenCalledOnce();
    expect([...commitTextInputs.mock.calls[0][0]]).toEqual([
      ["6:text", '{"regions":[]}'],
    ]);

    unmount();
  });

  it("fails atomically for missing or non-text inputs", () => {
    const commitTextInputs = vi.fn();
    const unmount = extensionGenerationBridge.mount({
      listInputs: () => [
        {
          id: "7:image",
          nodeId: "7",
          param: "image",
          label: "Image",
          inputType: "image",
        },
      ],
      commitTextInputs,
    });
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
    expect(commitTextInputs).not.toHaveBeenCalled();

    unmount();
    expect(api.transaction("Unavailable", () => undefined)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});
