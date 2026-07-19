import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostCommandTable } from "../../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../../core/shell/keybindingRegistry";
import { createExtensionCommandApi } from "../CommandRegistry";

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

function createHarness(scope: ExtensionApiScope) {
  const contextKeys = new HostContextKeyService();
  const keybindings = new HostKeybindingRegistry(() => false);
  const table = new HostCommandTable(contextKeys);
  const api = createExtensionCommandApi(scope, table, keybindings, contextKeys);
  return { api, table, keybindings, contextKeys };
}

describe("createExtensionCommandApi", () => {
  it("owner-qualifies commands and reports failures to the owning scope", async () => {
    const report = vi.fn();
    const scope = createScope("example.cmd", report);
    const { api, table } = createHarness(scope);
    api.register({
      id: "boom",
      apiVersion: 1,
      title: "Boom",
      run: () => {
        throw new Error("boom failed");
      },
    });

    expect(table.has("example.cmd/boom")).toBe(true);
    expect(table.isHostCommand("example.cmd/boom")).toBe(false);
    expect(table.executeCommand("example.cmd/boom", { source: "menu" })).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("example.cmd/boom"),
        expect.any(Error),
      );
    });
  });

  it("executes own commands by local ID and refuses non-allowlisted host commands", async () => {
    const scope = createScope("example.cmd");
    const { api, table } = createHarness(scope);
    const hostRun = vi.fn();
    table.registerHostCommand({
      id: "project.close",
      title: "Close project",
      run: hostRun,
    });
    const ownRun = vi.fn();
    api.register({ id: "tag", apiVersion: 1, title: "Tag", run: ownRun });

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
    const scope = createScope("example.cmd");
    const { api } = createHarness(scope);
    expect(() =>
      api.register({ id: "a", apiVersion: 1, title: "", run: vi.fn() }),
    ).toThrow(/title/);
    expect(() =>
      api.register({
        id: "Bad ID",
        apiVersion: 1,
        title: "A",
        run: vi.fn(),
      }),
    ).toThrow(/Invalid command ID/);
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
    const scope = createScope("example.cmd");
    const { api } = createHarness(scope);
    expect(() =>
      api.registerKeybinding({
        id: "orphan",
        apiVersion: 1,
        chord: "Mod+O",
        command: "missing",
      }),
    ).toThrow(/Register the command first/);
  });

  it("routes keybinding requests to owner-qualified commands", () => {
    const scope = createScope("example.cmd");
    const { api, table, keybindings } = createHarness(scope);
    const run = vi.fn();
    api.register({ id: "go", apiVersion: 1, title: "Go", run });
    api.registerKeybinding({
      id: "go-key",
      apiVersion: 1,
      chord: "Mod+Shift+G",
      command: "go",
    });

    expect(keybindings.list()).toHaveLength(1);
    expect(keybindings.list()[0]).toMatchObject({
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
      table.executeCommand(commandId, { source: "keybinding" }),
    );
    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledWith({ source: "keybinding" });
  });

  it("reads context keys detached through the bound API", () => {
    const scope = createScope("example.cmd");
    const { api, contextKeys } = createHarness(scope);
    contextKeys.set("focus.region", "timeline");
    expect(api.getContextKey("focus.region")).toBe("timeline");
    expect(api.getContextKey("missing")).toBeUndefined();
  });

  it("gates when-claused extension commands through the shared table", () => {
    const scope = createScope("example.cmd");
    const { api, table, contextKeys } = createHarness(scope);
    const run = vi.fn();
    api.register({
      id: "gated",
      apiVersion: 1,
      title: "Gated",
      when: { key: "project.open" },
      run,
    });

    expect(table.isEnabled("example.cmd/gated")).toBe(false);
    contextKeys.set("project.open", true);
    expect(table.isEnabled("example.cmd/gated")).toBe(true);
  });
});
