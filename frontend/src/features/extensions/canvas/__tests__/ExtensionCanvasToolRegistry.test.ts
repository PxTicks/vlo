import { describe, expect, it, vi } from "vitest";
import { HostCommandTable } from "../../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { CanvasToolHost } from "../../../../core/shell/canvasToolHost";
import type {
  ExtensionApiScope,
  ExtensionResource,
} from "../../types";
import { ExtensionCanvasToolRegistry } from "../ExtensionCanvasToolRegistry";

function createScope(extensionId: string) {
  const owned: ExtensionResource[] = [];
  const report = vi.fn<ExtensionApiScope["report"]>();
  const scope: ExtensionApiScope = {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      owned.push(resource);
      return resource;
    },
    report,
  };
  return { scope, owned, report };
}

function attachHost(registry: ExtensionCanvasToolRegistry) {
  const clearOverlay = vi.fn();
  const setCursor = vi.fn();
  const setExtensionToolActive = vi.fn();
  const registration = registry.attachHost({
    session: {
      overlay: {},
      targetClipId: "clip-1",
      projectToScreen: (point) => point,
      screenToProject: (point) => point,
      requestRender: vi.fn(),
    },
    clearOverlay,
    setCursor,
    setExtensionToolActive,
  });
  return {
    clearOverlay,
    registration,
    setCursor,
    setExtensionToolActive,
  };
}

describe("ExtensionCanvasToolRegistry", () => {
  it("projects each tool through the command table and arbitrates one active tool", () => {
    const contextKeys = new HostContextKeyService();
    const commands = new HostCommandTable(contextKeys);
    const registry = new ExtensionCanvasToolRegistry(contextKeys);
    const host = attachHost(registry);
    const { scope } = createScope("example.paint");
    const activate = vi.fn();
    const deactivate = vi.fn();
    const onPointer = vi.fn();

    const registration = registry.bind(scope, commands).register({
      id: "brush",
      apiVersion: 1,
      label: " Brush ",
      cursor: " cell ",
      activate,
      deactivate,
      onPointer,
    });

    expect(registration.command).toBe("canvas-tool.brush");
    expect(registry.listAvailable()[0]?.definition.label).toBe("Brush");
    expect(registry.listAvailable()[0]?.commandId).toBe(
      "example.paint/canvas-tool.brush",
    );
    expect(
      commands.executeCommand("example.paint/canvas-tool.brush", {
        source: "toolbar",
      }),
    ).toBe(true);
    expect(registry.getActiveId()).toBe("example.paint/brush");
    expect(activate).toHaveBeenCalledOnce();
    expect(host.setExtensionToolActive).toHaveBeenCalledWith(true);
    expect(host.setCursor).toHaveBeenCalledWith("cell");

    registry.dispatchPointer({
      kind: "down",
      projectPoint: { x: 10, y: 20 },
      screenPoint: { x: 30, y: 40 },
      pressure: 0.5,
      buttons: 1,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(onPointer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "down", projectPoint: { x: 10, y: 20 } }),
    );

    registry.deactivate();
    expect(deactivate).toHaveBeenCalledOnce();
    expect(host.clearOverlay).toHaveBeenCalled();
    expect(host.setExtensionToolActive).toHaveBeenLastCalledWith(false);
    host.registration.dispose();
  });

  it("switches tools with one revision and without dropping host mode", () => {
    const contextKeys = new HostContextKeyService();
    const canvasHost = new CanvasToolHost(contextKeys);
    const registry = new ExtensionCanvasToolRegistry(contextKeys, canvasHost);
    const commands = new HostCommandTable(contextKeys);
    const host = attachHost(registry);
    const { scope } = createScope("example.paint");
    const firstActivate = vi.fn();
    const secondActivate = vi.fn();
    const tools = registry.bind(scope, commands);
    tools.register({
      id: "brush",
      apiVersion: 1,
      label: "Brush",
      activate: firstActivate,
      deactivate: vi.fn(),
      onPointer: vi.fn(),
    });
    tools.register({
      id: "eraser",
      apiVersion: 1,
      label: "Eraser",
      activate: secondActivate,
      deactivate: vi.fn(),
      onPointer: vi.fn(),
    });

    expect(registry.activate("example.paint/brush")).toBe(true);
    const revisionBeforeSwitch = canvasHost.getRevision();
    expect(registry.activate("example.paint/eraser")).toBe(true);

    expect(canvasHost.getRevision()).toBe(revisionBeforeSwitch + 1);
    expect(host.setExtensionToolActive.mock.calls).toEqual([[true]]);
    expect(firstActivate).toHaveBeenCalledWith(
      expect.objectContaining({ targetClipId: "clip-1" }),
    );
    expect(secondActivate).toHaveBeenCalledWith(
      expect.objectContaining({ targetClipId: "clip-1" }),
    );
    host.registration.dispose();
  });

  it("filters tools by host context and deactivates on contribution disposal", () => {
    const contextKeys = new HostContextKeyService();
    const commands = new HostCommandTable(contextKeys);
    const registry = new ExtensionCanvasToolRegistry(contextKeys);
    const host = attachHost(registry);
    const { scope } = createScope("example.paint");
    const deactivate = vi.fn();
    const registration = registry.bind(scope, commands).register({
      id: "brush",
      apiVersion: 1,
      label: "Brush",
      when: { key: "project.open" },
      activate: vi.fn(),
      deactivate,
      onPointer: vi.fn(),
    });

    expect(registry.listAvailable()).toEqual([]);
    contextKeys.set("project.open", true);
    expect(registry.listAvailable()).toHaveLength(1);
    expect(registry.activate("example.paint/brush")).toBe(true);

    registration.dispose();
    expect(registry.getActiveId()).toBeNull();
    expect(deactivate).toHaveBeenCalledOnce();
    expect(commands.has("example.paint/canvas-tool.brush")).toBe(false);
    host.registration.dispose();
  });

  it("isolates callback failures and restores the host interaction mode", () => {
    const registry = new ExtensionCanvasToolRegistry(
      new HostContextKeyService(),
    );
    const commands = new HostCommandTable();
    const host = attachHost(registry);
    const { scope, report } = createScope("example.paint");
    registry.bind(scope, commands).register({
      id: "broken",
      apiVersion: 1,
      label: "Broken",
      activate: () => {
        throw new Error("activation failed");
      },
      deactivate: vi.fn(),
      onPointer: vi.fn(),
    });

    expect(registry.activate("example.paint/broken")).toBe(false);
    expect(registry.getActiveId()).toBeNull();
    expect(host.setExtensionToolActive).toHaveBeenLastCalledWith(false);
    expect(report).toHaveBeenCalledWith(
      "error",
      "Canvas tool activation failed.",
      expect.any(Error),
    );
    host.registration.dispose();
  });
});
