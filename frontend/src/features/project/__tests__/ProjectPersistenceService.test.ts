import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  projectPersistenceService,
} from "../services/ProjectPersistenceService";
import { fileSystemService } from "../services/FileSystemService";
import { PROJECT_MANIFEST_SCHEMA_VERSION } from "../constants";
import { isSafeProjectRelativePath } from "../schemas/projectPersistenceSchemas";

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

describe("ProjectPersistenceService", () => {
  let files: Map<string, string>;

  const manifest = {
    documentType: "vlo.project",
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: "project-1",
    title: "Split Project",
    created_at: 1000,
    last_modified: 1000,
    config: {},
    files: {
      timeline: "timeline.json",
      assets: "assets.json",
      assetMetadataDir: "asset-metadata",
    },
  };

  const timeline = {
    documentType: "vlo.timeline",
    schemaVersion: 1,
    updated_at: 1000,
    tracks: [
      {
        id: "track-1",
        label: "Track 1",
        isVisible: true,
        isMuted: false,
        isLocked: false,
      },
    ],
    clips: [],
  };

  const assetIndex = {
    documentType: "vlo.assets",
    schemaVersion: 1,
    updated_at: 1000,
    assets: {},
    assetFamilies: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projectPersistenceService.resetCaches();
    files = new Map<string, string>();

    (fileSystemService.readFile as Mock).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return { text: async () => content };
    });

    (fileSystemService.writeFile as Mock).mockImplementation(
      async (path: string, content: string) => {
        files.set(path, content);
      },
    );

    (fileSystemService.deleteFile as Mock).mockImplementation(async (path: string) => {
      files.delete(path);
    });
  });

  it("loads a split v3 project without rewriting files", async () => {
    files.set(".vloproject/project.json", JSON.stringify(manifest));
    files.set(".vloproject/timeline.json", JSON.stringify(timeline));
    files.set(".vloproject/assets.json", JSON.stringify(assetIndex));

    const loaded = await projectPersistenceService.loadOrMigrateProject();

    expect(loaded.manifest?.id).toBe("project-1");
    expect(loaded.timeline?.tracks).toHaveLength(1);
    expect(loaded.assetIndex?.assets).toEqual({});
    expect(loaded.migrated).toBe(false);
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an invalid v3 manifest without overwriting files", async () => {
    files.set(
      ".vloproject/project.json",
      JSON.stringify({
        documentType: "vlo.project",
        schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      }),
    );

    await expect(
      projectPersistenceService.loadOrMigrateProject(),
    ).rejects.toThrow();
    expect(fileSystemService.writeFile).not.toHaveBeenCalled();
  });

  it("migrates legacy projects into split files and sidecars heavy metadata", async () => {
    const legacyProject = {
      id: "legacy-project",
      title: "Legacy Project",
      schemaVersion: 2,
      created_at: 1000,
      config: { fps: 24 },
      timeline: {
        tracks: timeline.tracks,
        clips: [],
      },
      assets: {
        "asset-1": {
          id: "asset-1",
          hash: "hash-1",
          name: "render.mp4",
          type: "video",
          src: "render.mp4",
          createdAt: 1,
          creationMetadata: {
            source: "generated",
            workflowName: "Workflow",
            inputs: [],
            comfyuiPrompt: {
              "1": {
                class_type: "SaveImage",
                inputs: {},
              },
            },
          },
        },
      },
    };
    files.set(".vloproject/project.json", JSON.stringify(legacyProject));

    const loaded = await projectPersistenceService.loadOrMigrateProject();
    const writtenPaths = (fileSystemService.writeFile as Mock).mock.calls.map(
      ([path]) => path,
    );

    expect(loaded.migrated).toBe(true);
    expect(writtenPaths).toEqual([
      ".vloproject/project.legacy-v2.json",
      ".vloproject/asset-metadata/asset-1.json",
      ".vloproject/assets.json",
      ".vloproject/timeline.json",
      ".vloproject/project.json",
    ]);

    const migratedAssets = JSON.parse(files.get(".vloproject/assets.json")!);
    expect(migratedAssets.assets["asset-1"].metadataRef).toBe(
      "asset-metadata/asset-1.json",
    );
    expect(
      migratedAssets.assets["asset-1"].creationMetadata.comfyuiPrompt,
    ).toBeUndefined();

    const sidecar = JSON.parse(
      files.get(".vloproject/asset-metadata/asset-1.json")!,
    );
    expect(sidecar.creationMetadata.comfyuiPrompt).toBeDefined();

    const migratedManifest = JSON.parse(files.get(".vloproject/project.json")!);
    expect(migratedManifest.documentType).toBe("vlo.project");
    expect(migratedManifest.migratedFromSchemaVersion).toBe(2);
  });

  it("returns null for missing asset metadata sidecars", async () => {
    const document = await projectPersistenceService.readAssetMetadata(
      "asset-1",
      "asset-metadata/asset-1.json",
    );

    expect(document).toBeNull();
  });

  it("validates persisted project-relative paths", () => {
    expect(isSafeProjectRelativePath("clip.mp4")).toBe(true);
    expect(isSafeProjectRelativePath(".vloproject/thumbnails/clip.webp")).toBe(
      true,
    );
    expect(isSafeProjectRelativePath("../clip.mp4")).toBe(false);
    expect(isSafeProjectRelativePath("/tmp/clip.mp4")).toBe(false);
    expect(isSafeProjectRelativePath("blob:clip")).toBe(false);
  });
});
