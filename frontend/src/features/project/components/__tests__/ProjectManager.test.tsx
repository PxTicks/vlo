import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDirectoryHandle } from "../../../../testUtils/fileSystem";
import { ProjectManager } from "../ProjectManager";

const mocks = vi.hoisted(() => {
  class ProjectSchemaVersionError extends Error {}
  return {
    ProjectSchemaVersionError,
    pickDirectory: vi.fn(),
    verifyPermission: vi.fn(),
    getProjectDirectory: vi.fn(),
    setProjectDirectory: vi.fn(),
    getRecents: vi.fn(),
    removeRecent: vi.fn(),
    loadProject: vi.fn(),
    createProject: vi.fn(),
    isNonChromiumBrowser: vi.fn(() => false),
  };
});

vi.mock("../../services/FileSystemService", () => ({
  fileSystemService: {
    pickDirectory: mocks.pickDirectory,
    verifyPermission: mocks.verifyPermission,
  },
}));

vi.mock("../../services/RecentProjectsService", () => ({
  recentProjectsService: {
    getRecents: mocks.getRecents,
    removeRecent: mocks.removeRecent,
  },
}));

vi.mock("../../services/NewProjectDirectoryService", () => ({
  newProjectDirectoryService: {
    getDirectory: mocks.getProjectDirectory,
    setDirectory: mocks.setProjectDirectory,
  },
}));

vi.mock("../../services/ProjectPersistenceService", () => ({
  ProjectSchemaVersionError: mocks.ProjectSchemaVersionError,
}));

vi.mock("../../useProjectStore", () => ({
  useProjectStore: (
    selector: (state: {
      loadProject: typeof mocks.loadProject;
      createProject: typeof mocks.createProject;
    }) => unknown,
  ) =>
    selector({
      loadProject: mocks.loadProject,
      createProject: mocks.createProject,
    }),
}));

vi.mock("../../utils/browser", () => ({
  isNonChromiumBrowser: mocks.isNonChromiumBrowser,
}));

function recentProject(id = "recent-1", name = "Recent project") {
  return {
    id,
    name,
    lastOpened: new Date("2026-01-02T12:00:00Z").getTime(),
    handle: createMockDirectoryHandle(name),
  };
}

describe("ProjectManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecents.mockResolvedValue([]);
    mocks.removeRecent.mockResolvedValue(undefined);
    mocks.loadProject.mockResolvedValue(undefined);
    mocks.createProject.mockResolvedValue(undefined);
    mocks.verifyPermission.mockResolvedValue(true);
    mocks.getProjectDirectory.mockResolvedValue(null);
    mocks.setProjectDirectory.mockResolvedValue(undefined);
    mocks.isNonChromiumBrowser.mockReturnValue(false);
    vi.stubGlobal("alert", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads and displays recent projects", async () => {
    mocks.getRecents.mockResolvedValue([
      recentProject("one", "Project One"),
      recentProject("two", "Project Two"),
    ]);
    render(<ProjectManager />);

    expect(await screen.findByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("Project Two")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("No recent projects yet")).not.toBeInTheDocument();
  });

  it("warns non-Chromium browsers and shows the empty state", async () => {
    mocks.isNonChromiumBrowser.mockReturnValue(true);
    render(<ProjectManager />);
    expect(
      screen.getByText(/requires Chromium-based browsers/),
    ).toBeInTheDocument();
    expect(await screen.findByText("No recent projects yet")).toBeInTheDocument();
  });

  it("opens a selected project and handles picker failures", async () => {
    const handle = createMockDirectoryHandle();
    mocks.pickDirectory.mockResolvedValueOnce(handle);
    render(<ProjectManager />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => {
      expect(mocks.loadProject).toHaveBeenCalledWith(handle);
    });
    expect(mocks.pickDirectory).toHaveBeenCalledWith({
      id: "vlo-project",
      startIn: "videos",
    });

    mocks.pickDirectory.mockRejectedValueOnce(
      new DOMException("cancelled", "AbortError"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalledTimes(2));
    expect(globalThis.alert).not.toHaveBeenCalled();

    mocks.pickDirectory.mockRejectedValueOnce(new Error("permission denied"));
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith(
        "Failed to open project: permission denied",
      );
    });
  });

  it("opens permitted recent projects and ignores denied permission", async () => {
    const recent = recentProject();
    mocks.getRecents.mockResolvedValue([recent]);
    mocks.verifyPermission
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(<ProjectManager />);
    const recentButton = await screen.findByText(recent.name);

    fireEvent.click(recentButton);
    await waitFor(() => expect(mocks.verifyPermission).toHaveBeenCalled());
    expect(mocks.loadProject).not.toHaveBeenCalled();

    fireEvent.click(recentButton);
    await waitFor(() => {
      expect(mocks.loadProject).toHaveBeenCalledWith(recent.handle);
    });
    expect(mocks.verifyPermission).toHaveBeenLastCalledWith(
      recent.handle,
      true,
    );
  });

  it("reports schema-specific and generic recent-project failures", async () => {
    const recent = recentProject();
    mocks.getRecents.mockResolvedValue([recent]);
    mocks.loadProject
      .mockRejectedValueOnce(
        new mocks.ProjectSchemaVersionError("Project needs a newer vlo"),
      )
      .mockRejectedValueOnce(new Error("missing"));
    render(<ProjectManager />);
    const recentButton = await screen.findByText(recent.name);

    fireEvent.click(recentButton);
    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith(
        "Failed to open recent project: Project needs a newer vlo",
      );
    });
    fireEvent.click(recentButton);
    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith(
        "Failed to open recent project. It may have been moved or deleted.",
      );
    });
  });

  it("removes a recent project and reloads the list", async () => {
    const recent = recentProject();
    mocks.getRecents
      .mockResolvedValueOnce([recent])
      .mockResolvedValueOnce([]);
    render(<ProjectManager />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: `Remove ${recent.name} from recents`,
      }),
    );
    await waitFor(() => {
      expect(mocks.removeRecent).toHaveBeenCalledWith(recent.id);
      expect(mocks.getRecents).toHaveBeenCalledTimes(2);
    });
  });

  it("creates a project with selected settings", async () => {
    const parent = createMockDirectoryHandle("Workspace");
    mocks.pickDirectory.mockResolvedValue(parent);
    render(<ProjectManager />);

    fireEvent.click(
      screen.getByRole("button", { name: "Select project directory" }),
    );
    await waitFor(() => {
      expect(mocks.setProjectDirectory).toHaveBeenCalledWith(parent);
    });
    expect(screen.queryByText("New Project")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(await screen.findByText("New Project")).toBeInTheDocument();
    expect(mocks.verifyPermission).toHaveBeenCalledWith(parent, true);
    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "My project" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Vertical/ }));
    fireEvent.click(screen.getByRole("button", { name: /24 fps/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalledWith(
        "My project",
        parent,
        {
          aspectRatio: "9:16",
          fps: 24,
        },
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("New Project")).not.toBeVisible();
    });
  });

  it("validates creation and reports create failures", async () => {
    const parent = createMockDirectoryHandle("Workspace");
    mocks.getProjectDirectory.mockResolvedValue(parent);
    mocks.createProject.mockRejectedValue(new Error("cannot create"));
    render(<ProjectManager />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New project" }),
    );
    await screen.findByText("New Project");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(mocks.createProject).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "Broken project" },
    });
    fireEvent.keyDown(screen.getByLabelText("Project Name"), { key: "Enter" });
    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith(
        "Failed to create project: cannot create",
      );
    });
  });

  it("restores and changes the selected project directory", async () => {
    const restored = createMockDirectoryHandle("Restored workspace");
    const replacement = createMockDirectoryHandle("Replacement workspace");
    mocks.getProjectDirectory.mockResolvedValue(restored);
    mocks.pickDirectory.mockResolvedValue(replacement);
    render(<ProjectManager />);

    expect(await screen.findByText("Restored workspace")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Change project directory" }),
    );

    await waitFor(() => {
      expect(mocks.setProjectDirectory).toHaveBeenCalledWith(replacement);
    });
    expect(screen.getByText("Replacement workspace")).toBeInTheDocument();
  });

  it("requires access to a restored directory before opening the dialog", async () => {
    const parent = createMockDirectoryHandle("Workspace");
    mocks.getProjectDirectory.mockResolvedValue(parent);
    mocks.verifyPermission.mockResolvedValue(false);
    render(<ProjectManager />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New project" }),
    );

    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith(
        "Write access to the selected project directory is required.",
      );
    });
    expect(screen.queryByText("New Project")).not.toBeInTheDocument();
  });

  it("handles cancelled and failed workspace selection", async () => {
    mocks.pickDirectory
      .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
      .mockRejectedValueOnce(new Error("picker failed"));
    const errorSpy = vi.mocked(console.error);
    render(<ProjectManager />);

    fireEvent.click(
      screen.getByRole("button", { name: "Select project directory" }),
    );
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("New Project")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Select project directory" }),
    );
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });
});
