import { describe, expect, it, vi } from "vitest";
import { DedicatedWorkspaceRegistry } from "../DedicatedWorkspaceRegistry";
import type { DedicatedWorkspaceDefinition } from "../workspaceTypes";

interface Subject extends Record<string, string> {
  clipId: string;
}

function definition(
  overrides: Partial<DedicatedWorkspaceDefinition<Subject>> = {},
): DedicatedWorkspaceDefinition<Subject> {
  return {
    id: "host.fixture",
    title: "Fixture workspace",
    ownerId: "host.fixture",
    subjectSchema: {
      validate: (value): value is Subject =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.clipId === "string",
    },
    describeSubject: (subject) => subject.clipId,
    composition: {},
    createSession: () => ({ dispose: vi.fn() }),
    ...overrides,
  };
}

describe("DedicatedWorkspaceRegistry", () => {
  it("normalizes definitions and disposes all entries owned by a feature", () => {
    const registry = new DedicatedWorkspaceRegistry();
    registry.register(
      definition({
        composition: {
          stages: { "main-stage": { surfaceId: "host.preview" } },
          docks: {
            "right-sidebar": {
              mode: "replace",
              panels: [{ viewId: "host.scopes", required: true }],
            },
          },
        },
      }),
    );
    registry.register(
      definition({ id: "host.fixture-two", ownerId: "host.fixture" }),
    );

    expect(registry.list()).toHaveLength(2);
    registry.disposeOwner("host.fixture");
    expect(registry.list()).toEqual([]);
  });

  it("rejects ambiguous or invalid compositions at registration", () => {
    const registry = new DedicatedWorkspaceRegistry();
    expect(() => registry.register(definition({ id: "fixture" }))).toThrow(
      /Invalid workspace ID/,
    );
    expect(() =>
      registry.register(
        definition({
          composition: {
            stages: {
              "main-stage": { surfaceId: "host.same" },
              "lower-stage": { surfaceId: "host.same" },
            },
          },
        }),
      ),
    ).toThrow(/more than once/);
    expect(() =>
      registry.register(
        definition({
          composition: {
            docks: {
              "right-sidebar": {
                mode: "augment",
                panels: [{ viewId: "host.scopes" }],
                selectedViewId: "host.notes",
              },
            },
          },
        }),
      ),
    ).toThrow(/selects a panel not listed/);
  });

  it("notifies once when a registration is disposed", () => {
    const registry = new DedicatedWorkspaceRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const registration = registry.register(definition());
    listener.mockClear();

    registration.dispose();
    registration.dispose();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.get("host.fixture")).toBeUndefined();
  });
});
