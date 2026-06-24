import { describe, expect, it, vi } from "vitest";
import {
  isGraphMutationInFlight,
  preResolvePrompt,
} from "../preResolvePrompt";

function iframeWithApp(app?: unknown): HTMLIFrameElement {
  return {
    contentWindow: app ? { app } : {},
  } as unknown as HTMLIFrameElement;
}

describe("preResolvePrompt", () => {
  it("returns null when the embedded app is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(preResolvePrompt(iframeWithApp(), [], [])).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(isGraphMutationInFlight()).toBe(false);
  });

  it("mutates nodes and widgets only during prompt resolution, then reverts", async () => {
    const widget = { name: "seed", value: 1, callback: vi.fn() };
    const node = { id: 3, mode: 0, widgets: [widget] };
    const getNodeById = vi.fn((id: number) => (id === 3 ? node : null));
    const setDirtyCanvas = vi.fn();
    const graphToPrompt = vi.fn(async () => {
      expect(isGraphMutationInFlight()).toBe(true);
      expect(node.mode).toBe(4);
      expect(widget.value).toBe(99);
      return {
        output: { prompt: true },
        workflow: { nodes: [] },
      };
    });

    await expect(
      preResolvePrompt(
        iframeWithApp({
          graph: { getNodeById, setDirtyCanvas },
          graphToPrompt,
        }),
        ["3", "404"],
        [
          { node_id: "3", widget: "seed", value: 99 },
          { node_id: "3", widget: "missing", value: "ignored" },
          { node_id: "404", widget: "seed", value: 2 },
        ],
      ),
    ).resolves.toEqual({
      output: { prompt: true },
      workflow: { nodes: [] },
    });

    expect(node.mode).toBe(0);
    expect(widget.value).toBe(1);
    expect(setDirtyCanvas).toHaveBeenCalledWith(true, true);
    expect(isGraphMutationInFlight()).toBe(false);
  });

  it("reverts mutations and returns null when graph resolution fails", async () => {
    const node = { id: 1, mode: 2, widgets: [] };
    const setDirtyCanvas = vi.fn(() => {
      throw new Error("canvas disposed");
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      preResolvePrompt(
        iframeWithApp({
          graph: {
            getNodeById: vi.fn(() => node),
            setDirtyCanvas,
          },
          graphToPrompt: vi.fn(async () => {
            throw new Error("prompt failed");
          }),
        }),
        ["1"],
        [],
      ),
    ).resolves.toBeNull();

    expect(node.mode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      "[preResolvePrompt] graphToPrompt failed:",
      expect.any(Error),
    );
    expect(isGraphMutationInFlight()).toBe(false);
  });
});
