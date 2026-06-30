import { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../..";
import { extensionPayloadProviderRegistry } from "../../persistence/ExtensionPayloadProviderRegistry";
import { ExtensionEntityProviderRegistry } from "../ExtensionEntityProviderRegistry";

function createScope(extensionId: string): {
  scope: ExtensionApiScope;
  owned: ExtensionResource[];
  report: ReturnType<typeof vi.fn>;
} {
  const owned: ExtensionResource[] = [];
  const report = vi.fn();
  return {
    owned,
    report,
    scope: {
      extension: { id: extensionId, version: "1.0.0" },
      signal: new AbortController().signal,
      own: (resource) => {
        owned.push(resource);
        return resource;
      },
      report,
    },
  };
}

describe("ExtensionEntityProviderRegistry", () => {
  it("atomically registers persistence and a trusted Pixi lifecycle", () => {
    const registry = new ExtensionEntityProviderRegistry();
    const { scope } = createScope("example.vector-shapes");
    const object = new Container();
    const update = vi.fn();
    const extensionDestroy = vi.fn();
    const registration = registry.bind(scope).register({
      id: "star",
      apiVersion: 1,
      kind: "trusted-pixi",
      label: "Vector star",
      timelineColor: "#7c3aed",
      schemaVersion: 1,
      defaultPayload: { points: 5 },
      validate: (data) => {
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new Error("Expected shape data.");
        }
      },
      createRenderable: () => ({
        object,
        update,
        destroy: extensionDestroy,
      }),
    });
    const payload = {
      extensionId: "example.vector-shapes",
      typeId: "star",
      schemaVersion: 1,
      data: { points: 7 },
    };

    expect(registration.id).toBe("example.vector-shapes/star");
    expect(registry.getAvailability(payload)).toBe("available");
    expect(registry.getTimelinePresentation(payload)).toEqual({
      label: "Vector star",
      color: "#7c3aed",
    });
    expect(extensionPayloadProviderRegistry.resolve(payload).status).toBe(
      "current",
    );

    const provider = registry.get(payload);
    if (!provider) throw new Error("Expected registered provider.");
    const created = provider.definition.createRenderable();
    if (!created) throw new Error("Expected trusted renderable.");
    const slot = new Container();
    const context = {
      entity: {
        id: "shape-1",
        name: "Star",
        trackId: "track-1",
        startTicks: 0,
        durationTicks: 100,
      },
      frame: {
        projectWidth: 1920,
        projectHeight: 1080,
        presentationTimeTicks: 10,
        visualTimeTicks: 10,
        sourceTimeTicks: 10,
        fps: 30,
      },
      renderer: {},
      assets: { get: () => undefined },
    };
    expect(
      provider.definition.updateRenderable(
        created,
        { data: { points: 7 }, schemaVersion: 1 },
        context,
        slot,
      ),
    ).toBe(true);
    expect(created.parent).toBe(slot);
    expect(update).toHaveBeenCalledOnce();

    registration.dispose();

    expect(created.destroyed).toBe(true);
    expect(extensionDestroy).toHaveBeenCalledOnce();
    expect(registry.getAvailability(payload)).toBe("missing");
    expect(extensionPayloadProviderRegistry.resolve(payload).status).toBe(
      "missing",
    );
  });

  it("rejects invalid defaults before publishing either half", () => {
    const registry = new ExtensionEntityProviderRegistry();
    const { scope } = createScope("example.invalid-entity");

    expect(() =>
      registry.bind(scope).register({
        id: "card",
        apiVersion: 1,
        kind: "trusted-pixi",
        label: "Card",
        schemaVersion: 1,
        defaultPayload: { valid: false },
        validate: () => {
          throw new Error("invalid default");
        },
        createRenderable: () => ({
          object: new Container(),
          update: () => undefined,
        }),
      }),
    ).toThrow("invalid default");

    const payload = {
      extensionId: "example.invalid-entity",
      typeId: "card",
      schemaVersion: 1,
      data: {},
    };
    expect(registry.get(payload)).toBeUndefined();
    expect(extensionPayloadProviderRegistry.get(payload)).toBeUndefined();
  });
});
