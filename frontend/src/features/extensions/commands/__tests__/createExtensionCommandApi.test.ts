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

    await expect(api.execute("tag", { assetId: "a1" })).resolves.toBe(true);
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

  it("reports a disabled command as an outcome rather than a silent success", async () => {
    const scope = createScope("example.cmd");
    const { api, contextKeys } = createHarness(scope);
    const run = vi.fn();
    contextKeys.set("project.open", false);
    api.register({
      id: "tag",
      apiVersion: 1,
      title: "Tag",
      when: { key: "project.open" },
      run,
    });

    // The caller has to be able to tell "did not run" from "ran": a silent
    // resolve made a gated command indistinguishable from a successful one.
    await expect(api.execute("tag")).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();

    contextKeys.set("project.open", true);
    await expect(api.execute("tag")).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("executes a host command only once the host opts that command in", async () => {
    const scope = createScope("example.cmd");
    const { api, table } = createHarness(scope);
    const openRun = vi.fn();
    const closedRun = vi.fn();
    table.registerHostCommand({
      id: "project.open-thing",
      title: "Open",
      allowExtensionExecute: true,
      run: openRun,
    });
    table.registerHostCommand({
      id: "project.close-thing",
      title: "Close",
      run: closedRun,
    });

    await expect(api.execute("project.open-thing")).resolves.toBe(true);
    expect(openRun).toHaveBeenCalledTimes(1);

    await expect(api.execute("project.close-thing")).rejects.toThrow(
      /not allowlisted/,
    );
    expect(closedRun).not.toHaveBeenCalled();
  });

  it("drops the allowance when the command is unregistered", async () => {
    const scope = createScope("example.cmd");
    const { api, table } = createHarness(scope);
    const registration = table.registerHostCommand({
      id: "project.open-thing",
      title: "Open",
      allowExtensionExecute: true,
      run: vi.fn(),
    });
    await expect(api.execute("project.open-thing")).resolves.toBe(true);

    void registration.dispose();

    // The grant lives on the entry, so it cannot outlive it and be inherited
    // by a later command that happens to reuse the ID.
    table.registerHostCommand({
      id: "project.open-thing",
      title: "Open again",
      run: vi.fn(),
    });
    await expect(api.execute("project.open-thing")).rejects.toThrow(
      /not allowlisted/,
    );
  });

  it("resolves its own command ahead of a host command with the same ID", async () => {
    const scope = createScope("example.cmd");
    const { api, table } = createHarness(scope);
    const hostRun = vi.fn();
    const ownRun = vi.fn();
    // Local IDs may contain dots, so a collision with a host ID is legal and
    // an extension must not be locked out of its own command by one.
    table.registerHostCommand({
      id: "project.open-thing",
      title: "Host open",
      run: hostRun,
    });
    api.register({
      id: "project.open-thing",
      apiVersion: 1,
      title: "Own open",
      run: ownRun,
    });

    await expect(api.execute("project.open-thing")).resolves.toBe(true);
    expect(ownRun).toHaveBeenCalledTimes(1);
    expect(hostRun).not.toHaveBeenCalled();
  });

  it("notifies extension subscribers when host context keys change", () => {
    const scope = createScope("example.cmd");
    const { api, contextKeys } = createHarness(scope);
    const listener = vi.fn();
    const unsubscribe = api.subscribeContextKeys(listener);

    contextKeys.set("project.open", true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getContextKey("project.open")).toBe(true);

    unsubscribe();
    contextKeys.set("project.open", false);
    expect(listener).toHaveBeenCalledTimes(1);
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

describe("contributed context keys", () => {
  function createOwnedScope(extensionId: string) {
    const controller = new AbortController();
    const resources: ExtensionResource[] = [];
    const scope: ExtensionApiScope = {
      extension: { id: extensionId, version: "1.0.0" },
      signal: controller.signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report: vi.fn(),
    };
    return {
      scope,
      controller,
      resourceCount: () => resources.length,
      dispose: async () => {
        for (const resource of [...resources].reverse()) {
          await (typeof resource === "function"
            ? resource()
            : resource.dispose());
        }
      },
    };
  }

  it("namespaces a write and returns the qualified key", () => {
    const harness = createOwnedScope("example.writer");
    const { api, contextKeys } = createHarness(harness.scope);

    expect(api.setContextKey("scanned", 3)).toBe(
      "extension.example.writer.scanned",
    );
    expect(contextKeys.get("extension.example.writer.scanned")).toBe(3);
    // Readable by anyone, including through a `when` clause.
    expect(api.getContextKey("extension.example.writer.scanned")).toBe(3);
  });

  it("gates a command's own `when` on a contributed key", async () => {
    const harness = createOwnedScope("example.writer");
    const { api, table } = createHarness(harness.scope);
    const run = vi.fn();
    api.register({
      id: "report",
      apiVersion: 1,
      title: "Report",
      when: { key: "extension.example.writer.scanned" },
      run,
    });

    expect(await api.execute("report")).toBe(false);
    expect(run).not.toHaveBeenCalled();

    api.setContextKey("scanned", 3);
    expect(table.isEnabled("example.writer/report")).toBe(true);
    expect(await api.execute("report")).toBe(true);
  });

  it("lets one package read another's key", () => {
    const contextKeys = new HostContextKeyService();
    const keybindings = new HostKeybindingRegistry(() => false);
    const table = new HostCommandTable(contextKeys);
    const writer = createExtensionCommandApi(
      createScope("example.writer"),
      table,
      keybindings,
      contextKeys,
    );
    const reader = createExtensionCommandApi(
      createScope("example.reader"),
      table,
      keybindings,
      contextKeys,
    );

    writer.setContextKey("ready", true);
    expect(reader.getContextKey("extension.example.writer.ready")).toBe(true);
    // But cannot write it: `setContextKey` only ever addresses its own namespace.
    expect(reader.setContextKey("ready", false)).toBe(
      "extension.example.reader.ready",
    );
    expect(contextKeys.get("extension.example.writer.ready")).toBe(true);
  });

  it("clears every key it wrote on deactivation, and only once", async () => {
    const harness = createOwnedScope("example.writer");
    const { api, contextKeys } = createHarness(harness.scope);
    contextKeys.set("project.open", true);

    api.setContextKey("one", 1);
    api.setContextKey("two", 2);
    // One cleanup however many keys are written.
    expect(harness.resourceCount()).toBe(1);

    await harness.dispose();
    expect(contextKeys.get("extension.example.writer.one")).toBeUndefined();
    expect(contextKeys.get("extension.example.writer.two")).toBeUndefined();
    expect(contextKeys.get("project.open")).toBe(true);
  });

  it("refuses a malformed key without registering a cleanup", () => {
    const harness = createOwnedScope("example.writer");
    const { api } = createHarness(harness.scope);

    expect(() => api.setContextKey("bad key", 1)).toThrow(/Invalid/);
    expect(() => api.setContextKey("extension.other", 1)).toThrow(
      /reserved prefix/,
    );
    expect(() => api.setContextKey("value", Number.NaN as never)).toThrow(
      /finite JSON/,
    );
    expect(harness.resourceCount()).toBe(0);
  });

  it("takes the key back when ownership is refused", () => {
    const contextKeys = new HostContextKeyService();
    const keybindings = new HostKeybindingRegistry(() => false);
    const table = new HostCommandTable(contextKeys);
    const api = createExtensionCommandApi(
      {
        extension: { id: "example.writer", version: "1.0.0" },
        signal: new AbortController().signal,
        own: () => {
          throw new Error("registration closed");
        },
        report: vi.fn(),
      },
      table,
      keybindings,
      contextKeys,
    );

    expect(() => api.setContextKey("scanned", 1)).toThrow(/registration closed/);
    expect(contextKeys.get("extension.example.writer.scanned")).toBeUndefined();
  });

  it("refuses a write after deactivation", () => {
    const harness = createOwnedScope("example.writer");
    const { api } = createHarness(harness.scope);
    harness.controller.abort();
    expect(() => api.setContextKey("late", 1)).toThrow(/no longer write/);
  });
});
