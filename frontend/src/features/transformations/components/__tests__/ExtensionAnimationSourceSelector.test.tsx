import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
} from "../../../extensions/types";
import { createExtensionAnimationApi } from "../../animation";
import { ExtensionAnimationSourceSelector } from "../ExtensionAnimationSourceSelector";

const owned: ExtensionResource[] = [];

function createScope(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: (resource) => {
      owned.push(resource);
      return resource;
    },
    report: () => undefined,
  };
}

afterEach(async () => {
  while (owned.length > 0) {
    const resource = owned.pop();
    if (typeof resource === "function") await resource();
    else await resource?.dispose();
  }
});

describe("ExtensionAnimationSourceSelector", () => {
  it("constructs a registered procedural source from its validated default", () => {
    const api = createExtensionAnimationApi(createScope("test.selector-source"));
    api.scalarSources.register({
      id: "wave",
      apiVersion: 1,
      label: "Wave",
      schemaVersion: 2,
      defaultData: { amplitude: 4 },
      validate: () => undefined,
      compile: () => ({
        sample: () => 0,
        dispose: () => undefined,
      }),
    });
    const onChange = vi.fn();
    render(
      <ExtensionAnimationSourceSelector
        value={{
          type: "spline",
          points: [
            { time: 0, value: 0 },
            { time: 10, value: 1 },
          ],
        }}
        minTime={0}
        duration={10}
        onChange={onChange}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Wave · source" }));

    expect(onChange).toHaveBeenCalledWith({
      type: "extension-scalar",
      source: {
        extensionId: "test.selector-source",
        typeId: "wave",
        schemaVersion: 2,
        data: { amplitude: 4 },
      },
    });
  });

  it("preserves host keyframes when selecting a segment provider", () => {
    const api = createExtensionAnimationApi(
      createScope("test.selector-interpolation"),
    );
    api.interpolations.register({
      id: "curve",
      apiVersion: 1,
      label: "Custom curve",
      schemaVersion: 1,
      defaultData: { tension: 0.5 },
      validate: () => undefined,
      compile: () => ({ sample: () => 0, dispose: () => undefined }),
    });
    const onChange = vi.fn();
    render(
      <ExtensionAnimationSourceSelector
        value={{
          type: "spline",
          points: [
            { time: 2, value: 3 },
            { time: 8, value: 9 },
          ],
        }}
        minTime={0}
        duration={10}
        onChange={onChange}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Custom curve · keyframes" }),
    );

    expect(onChange).toHaveBeenCalledWith({
      type: "extension-keyframed-scalar",
      keyframes: [
        {
          time: 2,
          value: 3,
          outgoing: {
            extensionId: "test.selector-interpolation",
            typeId: "curve",
            schemaVersion: 1,
            data: { tension: 0.5 },
          },
        },
        { time: 8, value: 9, outgoing: undefined },
      ],
    });
  });
});
