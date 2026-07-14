import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../types/Asset";
import type { ExtensionApiScope } from "../../types";

const {
  addLocalAssetMock,
  waitForAssetPersistenceMock,
  toExtensionAssetSnapshotMock,
} = vi.hoisted(() => ({
  addLocalAssetMock: vi.fn(),
  waitForAssetPersistenceMock: vi.fn(),
  toExtensionAssetSnapshotMock: vi.fn(),
}));

vi.mock("../../../userAssets/api", () => ({
  addLocalAsset: addLocalAssetMock,
  ensureAssetFileLoaded: vi.fn(),
  getAssetById: vi.fn(),
  getAssets: vi.fn(() => []),
  toExtensionAssetSnapshot: toExtensionAssetSnapshotMock,
  waitForAssetPersistence: waitForAssetPersistenceMock,
}));

import { createExtensionAssetApi } from "../createExtensionAssetApi";

if (typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    configurable: true,
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

const IDENTITY_CUBE = [
  "LUT_3D_SIZE 2",
  "0 0 0",
  "1 0 0",
  "0 1 0",
  "1 1 0",
  "0 0 1",
  "1 0 1",
  "0 1 1",
  "1 1 1",
].join("\n");

function createScope(signal = new AbortController().signal): ExtensionApiScope {
  return {
    extension: Object.freeze({ id: "example.assets", version: "1.0.0" }),
    signal,
    own: (resource) => resource,
    report: () => undefined,
  };
}

describe("createExtensionAssetApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ingests, hash-reuses, and waits for project persistence", async () => {
    const asset = {
      id: "lut-1",
      hash: "hash-1",
      name: "warm.cube",
      type: "lut",
      src: "warm.cube",
    } as Asset;
    const snapshot = {
      id: "lut-1",
      hash: "hash-1",
      name: "warm.cube",
      type: "lut" as const,
      src: "warm.cube",
    };
    addLocalAssetMock.mockResolvedValue(asset);
    waitForAssetPersistenceMock.mockResolvedValue(undefined);
    toExtensionAssetSnapshotMock.mockReturnValue(snapshot);
    const api = createExtensionAssetApi(createScope());

    await expect(
      api.ingest({
        name: "warm.cube",
        type: "lut",
        blob: new Blob([IDENTITY_CUBE], { type: "text/plain" }),
      }),
    ).resolves.toEqual(snapshot);

    expect(addLocalAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "warm.cube" }),
      { source: "uploaded" },
      undefined,
      { expectedType: "lut", reuseExistingHash: true },
    );
    expect(waitForAssetPersistenceMock).toHaveBeenCalledWith("lut-1");
  });

  it("rejects malformed LUT bytes before project ingestion", async () => {
    const api = createExtensionAssetApi(createScope());

    await expect(
      api.ingest({
        name: "broken.cube",
        type: "lut",
        blob: new Blob(["LUT_3D_SIZE 2\nnot numbers\n"]),
      }),
    ).rejects.toThrow();
    expect(addLocalAssetMock).not.toHaveBeenCalled();
  });
});
