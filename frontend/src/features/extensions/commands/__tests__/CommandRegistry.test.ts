import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostCommandRegistry } from "../CommandRegistry";
import { HostContextKeyService } from "../contextKeys";
import { HostKeybindingRegistry } from "../KeybindingRegistry";

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

function createRegistry() {
  const contextKeys = new HostContextKeyService();
  const keybindings = new HostKeybindingRegistry(() => false);
  const registry = new HostCommandRegistry(contextKeys, keybindings);
  return { registry, contextKeys, keybindings };
}

describe("HostCommandRegistry", () => {
  it("registers host commands with stable dotted IDs and disposal", () => {
    const { registry } = createRegistry();
    const run = vi.fn();
    const registration = registry.registerHostCommand({
      id: "timeline.clip.delete",
      title: "Delete",
      run,
    });

    expect(registry.getTitle("timeline.clip.delete")).toBe("Delete");
    expect(
      registry.executeCommand("timeline.clip.delete", {
        subject: { clipId: "clip-1" },
        source: "menu",
      }),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith({
      subject: { clipId: "clip-1" },
      source: "menu",
    });

    registration.dispose();
    expect(registry.has("timeline.clip.delete")).toBe(false);
    expect(
      registry.executeCommand("timeline.clip.delete", { source: "menu" }),
    ).toBe(false);
  });

  it("rejects invalid host command IDs and duplicates", () => {
    const { registry } = createRegistry();
    expect(() =>
      registry.registerHostCommand({ id: "nodots", title: "X", run: vi.fn() }),
    ).toThrow(/Invalid host command ID/);
    registry.registerHostCommand({ id: "a.b", title: "X", run: vi.fn() });
    expect(() =>
      registry.registerHostCommand({ id: "a.b", title: "Y", run: vi.fn() }),
    ).toThrow(/already registered/);
  });

  it("gates execution on when-clauses over context keys", () => {
    const { registry, contextKeys } = createRegistry();
    const run = vi.fn();
    registry.registerHostCommand({
      id: "timeline.clip.copy",
      title: "Copy",
      when: { key: "project.open" },
      run,
    });

    expect(registry.isEnabled("timeline.clip.copy")).toBe(false);
    expect(
      registry.executeCommand("timeline.clip.copy", { source: "menu" }),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();

    contextKeys.set("project.open", true);
    expect(registry.isEnabled("timeline.clip.copy")).toBe(true);
    expect(
      registry.executeCommand("timeline.clip.copy", { source: "menu" }),
    ).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("owner-qualifies extension commands and isolates failures", async () => {
    const { registry } = createRegistry();
    const report = vi.fn();
    const api = registry.bind(createScope("example.cmd", report));
    api.register({
      id: "boom",
      apiVersion: 1,
      title: "Boom",
      run: () => {
        throw new Error("boom failed");
      },
    });

    expect(registry.has("example.cmd/boom")).toBe(true);
    expect(
      registry.executeCommand("example.cmd/boom", { source: "menu" }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("example.cmd/boom"),
        expect.any(Error),
      );
    });
  });

  it("executes own commands by local ID and refuses non-allowlisted host commands", async () => {
    const { registry } = createRegistry();
    const hostRun = vi.fn();
    registry.registerHostCommand({
      id: "project.close",
      title: "Close project",
      run: hostRun,
    });
    const ownRun = vi.fn();
    const api = registry.bind(createScope("example.cmd"));
    api.register({
      id: "tag",
      apiVersion: 1,
      title: "Tag",
      run: ownRun,
    });

    await api.execute("tag", { assetId: "a1" });
    expect(ownRun).toHaveBeenCalledWith({
      subject: { assetId: "a1" },
      source: "api",
    });

    await expect(api.execute("project.close")).rejects.toThrow(
      /not allowlisted/,
    );
    expect(hostRun).not.toHaveBeenCalled();
    await expect(api.execute("missing")).rejects.toThrow(/not registered/);
  });

  it("validates command definitions before registration", () => {
    const { registry } = createRegistry();
    const api = registry.bind(createScope("example.cmd"));
    expect(() =>
      api.register({ id: "a", apiVersion: 1, title: "", run: vi.fn() }),
    ).toThrow(/title/);
    expect(() =>
      api.register({
        id: "a",
        apiVersion: 1,
        title: "A",
        when: { key: "Bad Key" },
        run: vi.fn(),
      }),
    ).toThrow(/context key/);
  });

  it("rejects keybindings whose command is not yet registered", () => {
    const { registry } = createRegistry();
    const api = registry.bind(createScope("example.cmd"));
    expect(() =>
      api.registerKeybinding({
        id: "orphan",
        apiVersion: 1,
        chord: "Mod+O",
        command: "missing",
      }),
    ).toThrow(/Register the command first/);
  });

  it("notifies subscribers on host command registration and disposal", () => {
    const { registry } = createRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    const registration = registry.registerHostCommand({
      id: "a.b",
      title: "X",
      run: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    registration.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    // Extension registrations flow through the same subscription.
    registry.bind(createScope("example.cmd")).register({
      id: "c",
      apiVersion: 1,
      title: "C",
      run: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("routes keybinding requests to owner-qualified commands", () => {
    const { registry, keybindings } = createRegistry();
    const run = vi.fn();
    const api = registry.bind(createScope("example.cmd"));
    api.register({ id: "go", apiVersion: 1, title: "Go", run });
    api.registerKeybinding({
      id: "go-key",
      apiVersion: 1,
      chord: "Mod+Shift+G",
      command: "go",
    });

    const bindings = keybindings.list();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: "example.cmd/go-key",
      commandId: "example.cmd/go",
      active: true,
    });

    const event = new KeyboardEvent("keydown", {
      key: "G",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    const handled = keybindings.dispatch(event, "timeline", (commandId) =>
      registry.executeCommand(commandId, { source: "keybinding" }),
    );
    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledWith({ source: "keybinding" });
  });

  it("reads context keys detached through the bound API", () => {
    const { registry, contextKeys } = createRegistry();
    const api = registry.bind(createScope("example.cmd"));
    contextKeys.set("focus.region", "timeline");
    expect(api.getContextKey("focus.region")).toBe("timeline");
    expect(api.getContextKey("missing")).toBeUndefined();
  });
});
