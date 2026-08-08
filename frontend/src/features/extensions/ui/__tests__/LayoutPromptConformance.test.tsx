import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../..";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import { extensionGenerationBridge } from "../../generation/ExtensionGenerationBridge";
import { ExtensionModalHost } from "../ExtensionModalHost";
import { ExtensionUiSlot } from "../ExtensionUiSlot";
import { activate } from "../../../../../../extension-fixtures/layout-prompt/frontend/src/index";

describe("layout prompt UI conformance fixture", () => {
  it("launches from generation, previews layout JSON, and commits one input write", async () => {
    const resources: ExtensionResource[] = [];
    const scope: ExtensionApiScope = {
      extension: { id: "example.layout-prompt", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report: vi.fn(),
    };
    const commitTextInputs = vi.fn();
    const unmountGeneration = extensionGenerationBridge.mount({
      listInputs: () => [
        {
          id: "6:text",
          nodeId: "6",
          param: "text",
          label: "Positive prompt",
          inputType: "text",
          value: "old prompt",
        },
      ],
      commitTextInputs,
    });
    const api = createVloExtensionApi(scope);
    await activate({
      extension: scope.extension,
      sdkVersion: "1.0.0",
      signal: scope.signal,
      api,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onDispose: (resource) => resources.push(resource),
      exportApi: vi.fn(),
    });
    render(
      <>
        <ExtensionUiSlot slot="generation.toolbar" presentation="inline" />
        <ExtensionModalHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Layout prompt" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Visual layout prompt");
    const canvas = screen.getByRole("img", {
      name: "Visual prompt layout canvas",
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(canvas, { clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 800, clientY: 480, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 800, clientY: 480, pointerId: 1 });
    fireEvent.input(screen.getByLabelText("Region prompt"), {
      target: { value: "A violet robot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply JSON prompt" }));

    expect(commitTextInputs).toHaveBeenCalledOnce();
    const updates = commitTextInputs.mock.calls[0][0] as ReadonlyMap<
      string,
      string
    >;
    const prompt = JSON.parse(updates.get("6:text") ?? "null") as {
      schemaVersion: number;
      coordinateSpace: string;
      regions: Array<{
        prompt: string;
        color: string;
        boundingBox: Record<string, number>;
      }>;
    };
    expect(prompt).toMatchObject({
      schemaVersion: 1,
      coordinateSpace: "normalized",
      regions: [
        {
          prompt: "Primary subject",
          color: "#7c3aed",
          boundingBox: { x: 0.1, y: 0.12, width: 0.35, height: 0.3 },
        },
        {
          prompt: "A violet robot",
          color: "#06b6d4",
          boundingBox: { x: 0.5, y: 0.5, width: 0.3, height: 0.3 },
        },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    // The application-level modal can remain open after its generation-tab
    // adapter unmounts. Applying then reports the unavailable host without
    // throwing, closing, or issuing a stale write.
    fireEvent.click(screen.getByRole("button", { name: "Layout prompt" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unmountGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Apply JSON prompt" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "The generation panel is not mounted.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(commitTextInputs).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    for (const resource of resources.reverse()) {
      if (typeof resource === "function") await resource();
      else await resource.dispose();
    }
  });
});
