import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { projectDocumentService } from "../services/ProjectDocumentService";
import { fileSystemService } from "../services/FileSystemService";
import type { Patch } from "../../../lib/immerLite";

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe("ProjectDocumentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectDocumentService.resetProjectDocumentCache();
  });

  it("serializes concurrent updates without losing keys", async () => {
    let persisted = JSON.stringify({
      id: "project-1",
      title: "Original",
      assets: {},
      timeline: { tracks: [], clips: [] },
    });

    (fileSystemService.readFile as Mock).mockImplementation(async () => ({
      text: async () => persisted,
    }));
    (fileSystemService.writeFile as Mock).mockImplementation(
      async (_path: string, content: string) => {
        persisted = content;
      },
    );

    await Promise.all([
      projectDocumentService.updateProjectDocument((draft) => {
        if (!draft.assets) draft.assets = {};
        draft.assets["asset-1"] = {
          id: "asset-1",
          hash: "hash-1",
          name: "asset.mp4",
          type: "video",
          src: "asset.mp4",
          createdAt: 1,
        };
      }),
      projectDocumentService.updateProjectDocument((draft) => {
        draft.title = "Updated";
      }),
    ]);

    const parsed = JSON.parse(persisted);
    expect(parsed.title).toBe("Updated");
    expect(parsed.assets["asset-1"]).toBeDefined();
  });

  it("initializes an empty document when project.json is missing or unreadable", async () => {
    (fileSystemService.readFile as Mock).mockRejectedValue(
      new Error("File missing"),
    );
    (fileSystemService.writeFile as Mock).mockResolvedValue(undefined);

    const doc = await projectDocumentService.readProjectDocument();
    expect(doc).toEqual({});

    await projectDocumentService.updateProjectDocument((draft) => {
      draft.id = "project-2";
      draft.title = "Created";
    });

    expect(fileSystemService.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      (fileSystemService.writeFile as Mock).mock.calls[0][1] as string,
    );
    expect(written.id).toBe("project-2");
    expect(written.title).toBe("Created");
    expect(typeof written.last_modified).toBe("number");
  });

  it("falls back to a mutator when patch application fails", async () => {
    let persisted = JSON.stringify({
      id: "project-3",
      title: "No Timeline Yet",
    });

    (fileSystemService.readFile as Mock).mockImplementation(async () => ({
      text: async () => persisted,
    }));
    (fileSystemService.writeFile as Mock).mockImplementation(
      async (_path: string, content: string) => {
        persisted = content;
      },
    );

    const patches: Patch[] = [
      {
        op: "replace",
        path: ["timeline", "tracks"],
        value: [],
      },
    ];

    await projectDocumentService.applyProjectDocumentPatches(patches, (draft) => {
      draft.timeline = {
        tracks: [
          {
            id: "track-1",
            label: "Track 1",
            isVisible: true,
            isLocked: false,
            isMuted: false,
          },
        ],
        clips: [],
      };
    });

    const parsed = JSON.parse(persisted);
    expect(parsed.timeline).toBeDefined();
    expect(Array.isArray(parsed.timeline.tracks)).toBe(true);
  });
});

