/**
 * Editor-surface registration and ownership
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §4.1, §8.3).
 */
import { describe, expect, it, vi } from "vitest";
import { HostContextKeyService } from "../contextKeys";
import {
  cancelEditorSurfaceInteractions,
  EditorSurfaceRegistry,
  type EditorSurfaceDefinition,
} from "../editorSurfaces";
import { describeEditorSurfaces } from "../layout/layoutDescriptors";

function definition(
  overrides: Partial<EditorSurfaceDefinition> = {},
): EditorSurfaceDefinition {
  return {
    id: "host.surface",
    title: "Surface",
    defaultStage: "main-stage",
    component: () => null,
    ...overrides,
  };
}

describe("editor surface registration", () => {
  it("normalizes allowed stages into a canonical order", () => {
    const registry = new EditorSurfaceRegistry();
    registry.register(
      definition({
        defaultStage: "lower-stage",
        allowedStages: ["lower-stage", "main-stage", "lower-stage"],
      }),
    );

    expect(registry.get("host.surface")?.allowedStages).toEqual([
      "main-stage",
      "lower-stage",
    ]);
  });

  it("defaults a surface to the stage it registered for", () => {
    const registry = new EditorSurfaceRegistry();
    registry.register(definition());

    expect(registry.get("host.surface")?.allowedStages).toEqual(["main-stage"]);
  });

  it("rejects definitions the layout kernel could not trust", () => {
    const registry = new EditorSurfaceRegistry();

    expect(() => registry.register(definition({ id: "surface" }))).toThrow(
      /Invalid editor surface ID/,
    );
    expect(() =>
      registry.register(
        definition({ defaultStage: "left-sidebar" as "main-stage" }),
      ),
    ).toThrow(/unsupported stage/);
    expect(() =>
      registry.register(definition({ allowedStages: ["lower-stage"] })),
    ).toThrow(/must include its default stage/);
    expect(() => registry.register(definition({ allowedStages: [] }))).toThrow(
      /non-empty array/,
    );
    expect(() => registry.register(definition({ title: "  " }))).toThrow(
      /non-empty string/,
    );
    expect(() =>
      registry.register(definition({ order: Number.NaN })),
    ).toThrow(/must be finite/);
    expect(() =>
      registry.register(
        definition({
          cancelInteractions: "stop" as unknown as () => void,
        }),
      ),
    ).toThrow(/cancelInteractions must be a function/);

    registry.register(definition());
    expect(() => registry.register(definition())).toThrow(/already registered/);
  });

  it("frees the ID on disposal and notifies once per change", () => {
    const registry = new EditorSurfaceRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    const handle = registry.register(definition());
    expect(listener).toHaveBeenCalledTimes(1);

    handle.dispose();
    handle.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.get("host.surface")).toBeUndefined();
    expect(() => registry.register(definition())).not.toThrow();
  });

  it("evaluates availability against live context keys", () => {
    const contextKeys = new HostContextKeyService();
    const registry = new EditorSurfaceRegistry(contextKeys);
    registry.register(definition({ when: { key: "workspace.grading" } }));

    expect(registry.isAvailable("host.surface")).toBe(false);
    contextKeys.set("workspace.grading", true);
    expect(registry.isAvailable("host.surface")).toBe(true);
    expect(registry.isAvailable("host.absent")).toBe(false);

    expect(describeEditorSurfaces(registry)).toEqual([
      {
        id: "host.surface",
        defaultStage: "main-stage",
        allowedStages: ["main-stage"],
        defaultOrder: 0,
        available: true,
      },
    ]);
  });

  it("cancels through the registered surface, and survives one that throws", () => {
    const registry = new EditorSurfaceRegistry();
    const cancelInteractions = vi.fn();
    registry.register(definition({ cancelInteractions }));
    registry.register(
      definition({
        id: "host.broken",
        cancelInteractions: () => {
          throw new Error("no");
        },
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    cancelEditorSurfaceInteractions("host.surface", registry);
    expect(cancelInteractions).toHaveBeenCalledOnce();

    // A surface that cannot clean up must not trap the user in it.
    expect(() =>
      cancelEditorSurfaceInteractions("host.broken", registry),
    ).not.toThrow();
    expect(() =>
      cancelEditorSurfaceInteractions("host.absent", registry),
    ).not.toThrow();

    consoleError.mockRestore();
  });
});
