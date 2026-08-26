import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionBackendJobSnapshot,
  ExtensionKeyValueStore,
  JsonValue,
} from "../../types";
import {
  readTagIndex,
  refreshTagIndex,
  type TaggingApi,
} from "../../../../../../extension-fixtures/tagging/frontend/src/index";

function succeededJob(result?: JsonValue): ExtensionBackendJobSnapshot {
  return {
    jobId: "tag-job-1",
    jobType: "tag-assets",
    extensionId: "example.tagging",
    extensionVersion: "1.0.0",
    status: "succeeded",
    progress: 1,
    message: "Tagged fixture assets",
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 2,
    result,
    artifacts: [],
    diagnostics: [],
  };
}

describe("tagging storage conformance fixture", () => {
  it("persists backend-computed tags and reads updates reactively", async () => {
    const listeners = new Set<() => void>();
    const values = new Map<string, JsonValue>();
    const projectStorage: ExtensionKeyValueStore = {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, structuredClone(value));
        for (const listener of listeners) listener();
      },
      delete: async (key) => {
        values.delete(key);
        for (const listener of listeners) listener();
      },
      keys: async () => [...values.keys()],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getRevision: () => values.size,
    };
    const completed = succeededJob({
      schemaVersion: 1,
      tagsByAsset: { "asset-1": ["video", "mp4"] },
    });
    const submitJob = vi.fn(async () => succeededJob());
    const api: TaggingApi = {
      assets: {
        list: () =>
          [
            {
              id: "asset-1",
              hash: "hash-1",
              name: "scene.mp4",
              type: "video",
              src: "scene.mp4",
            },
          ] as never,
      },
      backend: {
        listJobs: async () => [
          {
            id: "tag-assets",
            label: "Tag fixture assets",
            timeoutSeconds: 10,
            usesLocalGpu: false,
            readiness: { ready: true, message: "Ready" },
          },
        ],
        submitJob,
        waitForJob: async () => completed,
      },
      storage: { local: projectStorage, project: projectStorage },
    };
    const changed = vi.fn();
    projectStorage.subscribe(changed);

    const index = await refreshTagIndex(api);

    expect(submitJob).toHaveBeenCalledWith("tag-assets", {
      schemaVersion: 1,
      assets: [{ id: "asset-1", name: "scene.mp4", type: "video" }],
    });
    expect(index.tagsByAsset["asset-1"]).toEqual(["video", "mp4"]);
    expect(await readTagIndex(projectStorage)).toEqual(index);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
