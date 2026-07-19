import { describe, expect, it, vi } from "vitest";
import { HostCommandTable } from "../commandTable";
import { HostContextKeyService } from "../contextKeys";

function createTable() {
  const contextKeys = new HostContextKeyService();
  return { table: new HostCommandTable(contextKeys), contextKeys };
}

describe("HostCommandTable", () => {
  it("registers host commands with stable dotted IDs and disposal", () => {
    const { table } = createTable();
    const run = vi.fn();
    const registration = table.registerHostCommand({
      id: "timeline.clip.delete",
      title: "Delete",
      run,
    });

    expect(table.getTitle("timeline.clip.delete")).toBe("Delete");
    expect(table.isHostCommand("timeline.clip.delete")).toBe(true);
    expect(
      table.executeCommand("timeline.clip.delete", {
        subject: { clipId: "clip-1" },
        source: "menu",
      }),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith({
      subject: { clipId: "clip-1" },
      source: "menu",
    });

    registration.dispose();
    expect(table.has("timeline.clip.delete")).toBe(false);
    expect(
      table.executeCommand("timeline.clip.delete", { source: "menu" }),
    ).toBe(false);
  });

  it("rejects invalid host command IDs and duplicates across sources", () => {
    const { table } = createTable();
    expect(() =>
      table.registerHostCommand({ id: "nodots", title: "X", run: vi.fn() }),
    ).toThrow(/Invalid host command ID/);
    table.registerHostCommand({ id: "a.b", title: "X", run: vi.fn() });
    expect(() =>
      table.registerHostCommand({ id: "a.b", title: "Y", run: vi.fn() }),
    ).toThrow(/already registered/);
    expect(() =>
      table.registerEntry({
        id: "a.b",
        title: "Z",
        run: vi.fn(),
        source: "extension",
        reportError: vi.fn(),
      }),
    ).toThrow(/already registered/);
  });

  it("gates execution on when-clauses over context keys", () => {
    const { table, contextKeys } = createTable();
    const run = vi.fn();
    table.registerHostCommand({
      id: "timeline.clip.copy",
      title: "Copy",
      when: { key: "project.open" },
      run,
    });

    expect(table.isEnabled("timeline.clip.copy")).toBe(false);
    expect(table.executeCommand("timeline.clip.copy", { source: "menu" })).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();

    contextKeys.set("project.open", true);
    expect(table.isEnabled("timeline.clip.copy")).toBe(true);
    expect(table.executeCommand("timeline.clip.copy", { source: "menu" })).toBe(
      true,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("isolates entry failures through the entry's reporter", async () => {
    const { table } = createTable();
    const reportError = vi.fn();
    table.registerEntry({
      id: "example.cmd/boom",
      title: "Boom",
      run: () => {
        throw new Error("boom failed");
      },
      source: "extension",
      reportError,
    });

    expect(
      table.executeCommand("example.cmd/boom", { source: "menu" }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(
        expect.stringContaining("example.cmd/boom"),
        expect.any(Error),
      );
    });
  });

  it("notifies subscribers on registration and disposal from either source", () => {
    const { table } = createTable();
    const listener = vi.fn();
    table.subscribe(listener);

    const host = table.registerHostCommand({
      id: "a.b",
      title: "X",
      run: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    table.registerEntry({
      id: "example.cmd/c",
      title: "C",
      run: vi.fn(),
      source: "extension",
      reportError: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
