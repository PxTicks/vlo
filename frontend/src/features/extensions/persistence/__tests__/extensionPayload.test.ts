import { describe, expect, it } from "vitest";
import {
  extensionPayloadSchema,
  jsonValueSchema,
} from "../extensionPayload";
import {
  collectProjectExtensionRequirements,
  getExtensionPayloadProviderId,
} from "../extensionRequirements";

describe("extensionPayloadSchema", () => {
  it("preserves nested opaque JSON and future envelope metadata", () => {
    const payload = {
      extensionId: "example.shapes",
      typeId: "star",
      schemaVersion: 2,
      data: {
        fill: "#ff00aa",
        points: [5, null, true, { inset: 0.42 }],
      },
      futureMetadata: { migrationHint: "keep-me" },
    };

    expect(extensionPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects values that JSON cannot preserve", () => {
    expect(jsonValueSchema.safeParse({ missing: undefined }).success).toBe(
      false,
    );
    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(
      false,
    );
    expect(
      extensionPayloadSchema.safeParse({
        extensionId: "Example Invalid",
        typeId: "star",
        schemaVersion: 0,
        data: {},
      }).success,
    ).toBe(false);
  });
});

describe("collectProjectExtensionRequirements", () => {
  it("groups entities by provider and reports the strictest availability", () => {
    const requirements = collectProjectExtensionRequirements(
      [
        {
          entityId: "clip-b",
          payload: {
            extensionId: "example.shapes",
            typeId: "star",
            schemaVersion: 2,
            data: {},
          },
        },
        {
          entityId: "clip-a",
          payload: {
            extensionId: "example.shapes",
            typeId: "star",
            schemaVersion: 1,
            data: {},
          },
        },
        {
          entityId: "clip-z",
          payload: {
            extensionId: "example.tracker",
            typeId: "path",
            schemaVersion: 3,
            data: [],
          },
        },
      ],
      (payload) =>
        payload.extensionId === "example.shapes" && payload.schemaVersion === 2
          ? "incompatible"
          : "available",
    );

    expect(requirements).toEqual([
      {
        id: "example.shapes/star",
        extensionId: "example.shapes",
        typeId: "star",
        schemaVersions: [1, 2],
        entityIds: ["clip-a", "clip-b"],
        availability: "incompatible",
      },
      {
        id: "example.tracker/path",
        extensionId: "example.tracker",
        typeId: "path",
        schemaVersions: [3],
        entityIds: ["clip-z"],
        availability: "available",
      },
    ]);
    expect(getExtensionPayloadProviderId(requirements[0]!)).toBe(
      "example.shapes/star",
    );
  });

  it("reports providers as missing until a resolver confirms them", () => {
    expect(
      collectProjectExtensionRequirements([
        {
          entityId: "clip-1",
          payload: {
            extensionId: "example.missing",
            typeId: "entity",
            schemaVersion: 1,
            data: null,
          },
        },
      ])[0]?.availability,
    ).toBe("missing");
  });
});
