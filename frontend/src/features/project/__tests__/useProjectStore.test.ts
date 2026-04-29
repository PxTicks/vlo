import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useProjectStore } from "../useProjectStore";
import { fileSystemService } from "../services/FileSystemService";
import { projectPersistenceService } from "../services/ProjectPersistenceService";
import { recentProjectsService } from "../services/RecentProjectsService";
import {
  PROJECT_MANIFEST_SCHEMA_VERSION,
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
  flushAllAssetPersistence: vi.fn(),
  scanForNewAssets: mockScanForNewAssets,
}));

describe("useProjectStore", () => {
  const defaultConfig = {
    aspectRatio: "16:9" as const,
    fps: 30,
    fitMode: "cover" as const,
    layoutMode: "compact" as const,
    assetBrowserDisplay: "grouped" as const,
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
    projectPersistenceService.resetCaches();
  });

  function getLastWrittenJson(path: string): Record<string, unknown> {
    const matchingCalls = (fileSystemService.writeFile as Mock).mock.calls.filter(
      ([fileName]) => fileName === path,
    );
    expect(matchingCalls.length).toBeGreaterThan(0);
    return JSON.parse(matchingCalls[matchingCalls.length - 1][1] as string);
  }

  function mockSplitProjectReadFiles(options: {
    manifest?: Record<string, unknown>;
    timeline?: Record<string, unknown>;
    assets?: Record<string, unknown>;
  }) {
    const manifest = options.manifest ?? {
      documentType: "vlo.project",
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      id: "project-id",
      title: "Loaded Project",
      created_at: 1000,
      last_modified: 1000,
      config: {},
      files: {
        timeline: "timeline.json",
        assets: "assets.json",
        assetMetadataDir: "asset-metadata",
      },
    };
    const timeline = options.timeline ?? {
      documentType: "vlo.timeline",
      schemaVersion: 1,
      updated_at: 1000,
      tracks: [],
      clips: [],
    };
    const assets = options.assets ?? {
      documentType: "vlo.assets",
      schemaVersion: 1,
      updated_at: 1000,
      assets: {},
      assetFamilies: {},
    };

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/project.json") {
        return { text: async () => JSON.stringify(manifest) };
      }
      if (path === ".vloproject/timeline.json") {
        return { text: async () => JSON.stringify(timeline) };
      }
      if (path === ".vloproject/assets.json") {
        return { text: async () => JSON.stringify(assets) };
      }
      throw new Error(`File not found: ${path}`);
    });
  }

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
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/assets.json",
      expect.any(String),
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/timeline.json",
      expect.any(String),
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
      ".vloproject/project.json",
      expect.any(String),
    );
    expect(recentProjectsService.addRecent).toHaveBeenCalled();

    const writtenData = getLastWrittenJson(".vloproject/project.json");

    expect(writtenData.documentType).toBe("vlo.project");
    expect(writtenData.schemaVersion).toBe(PROJECT_MANIFEST_SCHEMA_VERSION);
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
    const projectWrites = (fileSystemService.writeFile as Mock).mock.calls.filter(
      ([path]) => path === ".vloproject/project.json",
    );
    expect(projectWrites).toHaveLength(2); // Create + title update
  });

  it("should not update title if no project exists", async () => {
    // Act
    await useProjectStore.getState().updateTitle("Ghost Title");

    // Assert
    const { project } = useProjectStore.getState();
    expect(project).toBeNull();
  });

  it("should update title by writing only the project manifest", async () => {
      await useProjectStore.getState().createProject("Original Title", mockHandle);
      vi.mocked(fileSystemService.writeFile).mockClear();

      await useProjectStore.getState().updateTitle("New Title");

      expect(fileSystemService.writeFile).toHaveBeenCalledTimes(1);
      expect(fileSystemService.writeFile).toHaveBeenCalledWith(
        ".vloproject/project.json",
        expect.any(String),
      );
      expect(getLastWrittenJson(".vloproject/project.json").title).toBe("New Title");
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
    
    // Should persist the new split project files
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
        ".vloproject/project.json",
        expect.stringContaining('"title": "MockProject"')
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
        ".vloproject/timeline.json",
        expect.any(String)
    );
    expect(fileSystemService.writeFile).toHaveBeenCalledWith(
        ".vloproject/assets.json",
        expect.any(String)
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

  it("should hydrate timeline snapshot from timeline.json when present", async () => {
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

    mockSplitProjectReadFiles({
      timeline: {
        documentType: "vlo.timeline",
        schemaVersion: 1,
        updated_at: 1000,
        ...timeline,
      },
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useTimelineStore.getState().tracks).toEqual(timeline.tracks);
    expect(useTimelineStore.getState().clips).toEqual([
      expect.objectContaining({
        ...timeline.clips[0],
        transformations: [
          expect.objectContaining({ type: "fitMode", isEnabled: true }),
        ],
      }),
    ]);
  });

  it("should hydrate config from project manifest when present", async () => {
    mockSplitProjectReadFiles({
      manifest: {
        documentType: "vlo.project",
        schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
        id: "project-id",
        title: "Loaded Project",
        created_at: 1000,
        last_modified: 1000,
        config: {
          aspectRatio: "9:16",
          fps: 24,
          layoutMode: "full-height",
          assetBrowserDisplay: "ungrouped",
        },
        files: {
          timeline: "timeline.json",
          assets: "assets.json",
          assetMetadataDir: "asset-metadata",
        },
      },
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useProjectStore.getState().config).toEqual({
      aspectRatio: "9:16",
      fps: 24,
      fitMode: "contain",
      layoutMode: "full-height",
      assetBrowserDisplay: "ungrouped",
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
      assetBrowserDisplay: "ungrouped",
    });

    const writtenData = JSON.parse(persisted);

    expect(writtenData.schemaVersion).toBe(PROJECT_MANIFEST_SCHEMA_VERSION);
    expect(writtenData.createdWithVloVersion).toBe(VLO_APP_VERSION);
    expect(writtenData.lastSavedWithVloVersion).toBe(VLO_APP_VERSION);
    expect(writtenData.config).toEqual({
      aspectRatio: "9:16",
      fps: 24,
      fitMode: "cover",
      layoutMode: "full-height",
      assetBrowserDisplay: "ungrouped",
    });
  });

  it("should migrate legacy projects and default timeline snapshot when legacy project.json has no timeline", async () => {
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

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      if (path === ".vloproject/project.json") {
        return {
          text: async () =>
            JSON.stringify({
              id: "project-id",
              title: "Loaded Project",
              created_at: 1000,
            }),
        };
      }
      throw new Error(`File not found: ${path}`);
    });

    await useProjectStore.getState().loadProject(mockHandle);

    expect(useTimelineStore.getState().clips).toHaveLength(0);
    expect(useTimelineStore.getState().tracks).toHaveLength(1);
  });
});
