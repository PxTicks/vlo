import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useProjectStore } from "../useProjectStore";
import { fileSystemService } from "../services/FileSystemService";
import { projectDocumentService } from "../services/ProjectDocumentService";
import { recentProjectsService } from "../services/RecentProjectsService";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  VLO_APP_VERSION,
} from "../constants";
import { useTimelineStore } from "../../timeline";

const { mockScanForNewAssets } = vi.hoisted(() => ({
  mockScanForNewAssets: vi.fn(),
}));

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: {
    setHandle: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    checkDirectoryExists: vi.fn(),
  },
}));

vi.mock("../services/RecentProjectsService", () => ({
  recentProjectsService: {
    addRecent: vi.fn(),
  },
}));

vi.mock("../../userAssets", () => ({
  scanForNewAssets: mockScanForNewAssets,
}));

describe("useProjectStore", () => {
  const defaultConfig = {
    aspectRatio: "16:9" as const,
    fps: 30,
    layoutMode: "compact" as const,
  };

  const mockHandle = {
    name: "MockProject",
    getDirectoryHandle: vi.fn().mockResolvedValue({ name: "Title" }), // Mock handle
  } as unknown as FileSystemDirectoryHandle;

  beforeEach(() => {
    useProjectStore.setState({
      project: null,
      rootHandle: null,
      config: { ...defaultConfig },
    });
    useTimelineStore.getState().replaceTimelineSnapshot(null);
    vi.clearAllMocks();
    (fileSystemService.checkDirectoryExists as Mock).mockResolvedValue(false);
    projectDocumentService.resetProjectDocumentCache();
  });

  it("should initialize with no project", () => {
    const { project } = useProjectStore.getState();
    expect(project).toBeNull();
  });

  it("should create a new project with default values", async () => {
    const title = "My Awesome Video";

    // Act
    await useProjectStore.getState().createProject(title, mockHandle);

    // Assert
    const { project } = useProjectStore.getState();

    expect(project).not.toBeNull();
    expect(project?.title).toBe(title);
    expect(project?.rootAssetsFolder).toBe("Title"); // From mockHandle.getDirectoryHandle
    expect(project?.id).toBeDefined();

    // Verify services called
    expect(fileSystemService.setHandle).toHaveBeenCalled();
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(".vloproject/project.json", expect.any(String));
    expect(recentProjectsService.addRecent).toHaveBeenCalled();

    const [, content] = (fileSystemService.writeFile as Mock).mock.calls[0];
    const writtenData = JSON.parse(content as string);

    expect(writtenData.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(writtenData.createdWithVloVersion).toBe(VLO_APP_VERSION);
    expect(writtenData.lastSavedWithVloVersion).toBe(VLO_APP_VERSION);
  });

  it("should update the project title and save", async () => {
    // Arrange
    await useProjectStore.getState().createProject("Old Title", mockHandle);

    // Act
    await useProjectStore.getState().updateTitle("New Title");

    // Assert
    const { project } = useProjectStore.getState();
    expect(project?.title).toBe("New Title");
    // Should verify save was called again
    expect(fileSystemService.writeFile).toHaveBeenCalledTimes(2); // Create + Update
  });

  it("should not update title if no project exists", async () => {
    // Act
    await useProjectStore.getState().updateTitle("Ghost Title");

    // Assert
    const { project } = useProjectStore.getState();
    expect(project).toBeNull();
  });

  it("should preserve existing extra data (assets) in project.json when updating title", async () => {
      // 1. Simulate an existing project is loaded
      const initialProjectData = {
          id: "test-id",
          title: "Original Title",
          created_at: 1000,
          last_modified: 1000,
          assets: {
              "asset-1": { id: "asset-1", name: "video.mp4" }
          }
      };

      // Mock readFile to return the CURRENT state of the file on disk
      (fileSystemService.readFile as Mock).mockResolvedValue({
          text: async () => JSON.stringify(initialProjectData)
      });

      // Initialize Store State
      useProjectStore.setState({
          project: {
              id: initialProjectData.id,
              title: initialProjectData.title,
              createdAt: initialProjectData.created_at,
              lastModified: initialProjectData.last_modified,
              rootAssetsFolder: "root"
          },
          rootHandle: mockHandle
      });

      // 2. Perform Update
      await useProjectStore.getState().updateTitle("New Title");

      // 3. Verify what was written back
      expect(fileSystemService.writeFile).toHaveBeenCalled();
      
      const calls = (fileSystemService.writeFile as Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      const [fileName, content] = lastCall;
      
      expect(fileName).toBe(".vloproject/project.json");
      
      const writtenData = JSON.parse(content as string);
      
      // CHECK: Title is updated
      expect(writtenData.title).toBe("New Title");

      // CHECK: Assets are preserved
      expect(writtenData.assets).toBeDefined();
      expect(writtenData.assets["asset-1"]).toBeDefined();

      // CHECK: Legacy projects only get the last saved app version stamp.
      expect(writtenData.createdWithVloVersion).toBeUndefined();
      expect(writtenData.lastSavedWithVloVersion).toBe(VLO_APP_VERSION);
  });
  it("should initialize a new project and scan assets if project.json is missing", async () => {
    // 1. Simulate NO project.json (fail to read)
    (fileSystemService.readFile as Mock).mockRejectedValue(new Error("File not found"));

    // 2. Act
    await useProjectStore.getState().loadProject(mockHandle);

    // 3. Assert
    const { project } = useProjectStore.getState();
    await import("../../userAssets");

    // Should create new project structure
    expect(project).not.toBeNull();
    expect(project?.rootAssetsFolder).toBe("MockProject"); // From mockHandle.name
    
    // Should persist the new project.json
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
        ".vloproject/project.json",
        expect.stringContaining('"title": "MockProject"')
    );

    // Should scan for assets
    expect(mockScanForNewAssets).toHaveBeenCalled();

    expect(recentProjectsService.addRecent).toHaveBeenCalled();
  });

  it("should throw an error if the project directory already exists", async () => {
    // Arrange
    const title = "Duplicate Title";
    (fileSystemService.checkDirectoryExists as Mock).mockResolvedValue(true);

    // Act & Assert
    await expect(
      useProjectStore.getState().createProject(title, mockHandle)
    ).rejects.toThrow(`Project directory "${title}" already exists.`);

    // Check that we didn't proceed to create/save
    expect(mockHandle.getDirectoryHandle).not.toHaveBeenCalled();
    expect(fileSystemService.setHandle).not.toHaveBeenCalled();
    expect(recentProjectsService.addRecent).not.toHaveBeenCalled();
  });

  it("should hydrate timeline snapshot from project.json when present", async () => {
    const timeline = {
      tracks: [
        {
          id: "track-1",
          label: "Track 1",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [
        {
          id: "clip-1",
          trackId: "track-1",
          type: "video",
          name: "clip-1",
          start: 0,
          timelineDuration: 100,
          offset: 0,
          croppedSourceDuration: 100,
          transformedOffset: 0,
          sourceDuration: 100,
          transformedDuration: 100,
          transformations: [],
        },
      ],
    };

    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        JSON.stringify({
          id: "project-id",
          title: "Loaded Project",
          created_at: 1000,
          timeline,
        }),
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useTimelineStore.getState().tracks).toEqual(timeline.tracks);
    expect(useTimelineStore.getState().clips).toEqual(timeline.clips);
  });

  it("should hydrate config from project.json when present", async () => {
    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        JSON.stringify({
          id: "project-id",
          title: "Loaded Project",
          created_at: 1000,
          config: {
            aspectRatio: "9:16",
            fps: 24,
            layoutMode: "full-height",
          },
        }),
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useProjectStore.getState().config).toEqual({
      aspectRatio: "9:16",
      fps: 24,
      layoutMode: "full-height",
    });
  });

  it("should persist config updates to project.json", async () => {
    let persisted = "";

    (fileSystemService.readFile as Mock).mockImplementation(async () => ({
      text: async () => persisted,
    }));
    (fileSystemService.writeFile as Mock).mockImplementation(
      async (_path: string, content: string) => {
        persisted = content;
      },
    );

    await useProjectStore.getState().createProject("Project", mockHandle);

    await useProjectStore.getState().updateConfig({
      fps: 24,
      aspectRatio: "9:16",
      layoutMode: "full-height",
    });

    const writtenData = JSON.parse(persisted);

    expect(writtenData.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(writtenData.createdWithVloVersion).toBe(VLO_APP_VERSION);
    expect(writtenData.lastSavedWithVloVersion).toBe(VLO_APP_VERSION);
    expect(writtenData.config).toEqual({
      aspectRatio: "9:16",
      fps: 24,
      layoutMode: "full-height",
    });
  });

  it("should default timeline snapshot when project.json has no timeline", async () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [
        {
          id: "legacy-track",
          label: "Legacy",
          isVisible: true,
          isLocked: false,
          isMuted: false,
        },
      ],
      clips: [
        {
          id: "legacy-clip",
          trackId: "legacy-track",
          type: "video",
          name: "legacy-clip",
          start: 0,
          timelineDuration: 10,
          offset: 0,
          croppedSourceDuration: 10,
          transformedOffset: 0,
          sourceDuration: 10,
          transformedDuration: 10,
          transformations: [],
        },
      ],
    });

    (fileSystemService.readFile as Mock).mockResolvedValue({
      text: async () =>
        JSON.stringify({
          id: "project-id",
          title: "Loaded Project",
          created_at: 1000,
        }),
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(useTimelineStore.getState().tracks).toHaveLength(1);
  });
});
