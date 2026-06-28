import { describe, expect, it } from "vitest";
import type { ExtensionApiScope, ExtensionResource, JsonValue } from "../..";
import {
  ExtensionPayloadProviderRegistry,
  extensionPayloadProviderRegistry,
} from "../ExtensionPayloadProviderRegistry";
import { clipReferencesAssetId } from "../../../timeline/model/timelineCommands";
import type { ExtensionTimelineClip } from "../../../../types/TimelineTypes";

function createScope(extensionId: string): {
  scope: ExtensionApiScope;
  owned: ExtensionResource[];
} {
  const owned: ExtensionResource[] = [];
  return {
    owned,
    scope: {
      extension: { id: extensionId, version: "1.0.0" },
      signal: new AbortController().signal,
      own: (resource) => {
        owned.push(resource);
        return resource;
      },
      report: () => undefined,
    },
  };
}

function objectData(data: JsonValue): Record<string, JsonValue> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Expected object payload data.");
  }
  return data;
}

describe("ExtensionPayloadProviderRegistry", () => {
  it("migrates on clones, validates the current schema, and enumerates assets", () => {
    const registry = new ExtensionPayloadProviderRegistry();
    const { scope, owned } = createScope("example.shapes");
    registry.bind(scope).register({
      id: "star",
      apiVersion: 1,
      schemaVersion: 3,
      migrate: (data, fromSchemaVersion) => ({
        schemaVersion: fromSchemaVersion + 1,
        data: {
          ...objectData(data),
          [`migratedTo${fromSchemaVersion + 1}`]: true,
        },
      }),
      validate: (data, schemaVersion) => {
        const object = objectData(data);
        if (schemaVersion !== 3 || object.migratedTo3 !== true) {
          throw new Error("Payload is not current.");
        }
      },
      getAssetReferences: (data) => {
        const assetId = objectData(data).assetId;
        return typeof assetId === "string" ? [assetId, assetId] : [];
      },
    });

    const original = {
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 1,
      data: { points: 5, assetId: "asset-star" },
    };
    const resolution = registry.resolve(original);

    expect(resolution).toMatchObject({
      status: "migrated",
      payload: {
        schemaVersion: 3,
        data: { migratedTo2: true, migratedTo3: true },
      },
    });
    expect(original).toEqual({
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 1,
      data: { points: 5, assetId: "asset-star" },
    });
    expect(registry.resolveAssetReferences(original)).toMatchObject({
      ok: true,
      references: ["asset-star"],
    });
    expect(owned).toHaveLength(1);
  });

  it("retains the original payload when migration fails", () => {
    const registry = new ExtensionPayloadProviderRegistry();
    registry.bind(createScope("example.shapes").scope).register({
      id: "star",
      apiVersion: 1,
      schemaVersion: 2,
      migrate: () => {
        throw new Error("broken migration");
      },
      validate: () => undefined,
    });
    const original = {
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 1,
      data: { points: 5 },
    };

    const resolution = registry.resolve(original);

    expect(resolution.status).toBe("migration_failed");
    if (resolution.status !== "migration_failed") {
      throw new Error("Expected migration failure.");
    }
    expect(resolution.payload).toEqual(original);
    expect(resolution.error.message).toContain("broken migration");
  });

  it("reports missing and newer providers without interpreting their data", () => {
    const registry = new ExtensionPayloadProviderRegistry();
    const payload = {
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 5,
      data: { future: true },
    };

    expect(registry.resolve(payload).status).toBe("missing");
    const registration = registry.bind(createScope("example.shapes").scope).register({
      id: "star",
      apiVersion: 1,
      schemaVersion: 4,
      validate: () => undefined,
    });
    expect(registry.getAvailability(payload)).toBe("incompatible");
    expect(registry.resolve(payload).status).toBe("incompatible");

    registration.dispose();
    expect(registry.getAvailability(payload)).toBe("missing");
  });

  it("feeds declared asset references into core timeline reference checks", () => {
    const registration = extensionPayloadProviderRegistry
      .bind(createScope("example.assets").scope)
      .register({
        id: "card",
        apiVersion: 1,
        schemaVersion: 1,
        validate: () => undefined,
        getAssetReferences: (data) => {
          const assetId = objectData(data).assetId;
          return typeof assetId === "string" ? [assetId] : [];
        },
      });
    const clip: ExtensionTimelineClip = {
      id: "card-1",
      trackId: "track-1",
      type: "extension",
      name: "Card",
      sourceDuration: null,
      start: 0,
      timelineDuration: 100,
      offset: 0,
      transformedDuration: 100,
      transformedOffset: 0,
      croppedSourceDuration: 100,
      transformations: [],
      extensionPayload: {
        extensionId: "example.assets",
        typeId: "card",
        schemaVersion: 1,
        data: { assetId: "asset-card" },
      },
    };

    expect(clipReferencesAssetId(clip, "asset-card")).toBe(true);
    expect(clipReferencesAssetId(clip, "asset-other")).toBe(false);
    const assetResolution =
      extensionPayloadProviderRegistry.resolveAssetReferences(
        clip.extensionPayload,
      );
    if (!assetResolution.ok) {
      throw new Error("Expected asset references to resolve.");
    }
    clip.extensionPayload = assetResolution.payload;
    expect(clip.extensionPayload.assetReferences).toEqual(["asset-card"]);

    registration.dispose();
    expect(clipReferencesAssetId(clip, "asset-card")).toBe(true);
  });
});
