import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { projectPageActions } from "../services/ProjectPageActions";
import { installProjectHostCommands } from "../hostCommands";

const mocks = vi.hoisted(() => ({
  getRecents: vi.fn(),
  verifyPermission: vi.fn(),
  loadProject: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../services/RecentProjectsService", () => ({
  recentProjectsService: { getRecents: mocks.getRecents },
}));

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: { verifyPermission: mocks.verifyPermission },
}));

vi.mock("../useProjectStore", () => ({
  useProjectStore: Object.assign(vi.fn(), {
    getState: () => ({
      loadProject: mocks.loadProject,
      updateConfig: mocks.updateConfig,
    }),
  }),
}));

describe("project host commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPermission.mockResolvedValue(true);
    mocks.loadProject.mockResolvedValue(undefined);
  });

  it("opens a recent project only through a user-dispatched command", async () => {
    const handle = {} as FileSystemDirectoryHandle;
    mocks.getRecents.mockResolvedValue([
      { id: "recent-1", name: "One", lastOpened: 1, handle },
    ]);
    const keys = new HostContextKeyService();
    keys.set("project.open", false);
    const table = new HostCommandTable(keys);
    const registration = installProjectHostCommands(table);

    expect(
      table.executeCommand("projects.open", {
        source: "menu",
        subject: { recentId: "recent-1" },
      }),
    ).toBe(true);
    await waitFor(() => expect(mocks.loadProject).toHaveBeenCalledWith(handle));
    expect(table.isHostExecuteAllowlisted("projects.open")).toBe(false);
    registration.dispose();
  });

  it("routes create to the mounted projects-page UI", () => {
    const handler = vi.fn();
    const pageRegistration = projectPageActions.setCreateHandler(handler);
    const keys = new HostContextKeyService();
    keys.set("project.open", false);
    const table = new HostCommandTable(keys);
    const registration = installProjectHostCommands(table);

    expect(
      table.executeCommand("projects.create", { source: "menu" }),
    ).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(table.isHostExecuteAllowlisted("projects.create")).toBe(false);

    registration.dispose();
    pageRegistration.dispose();
  });
});
