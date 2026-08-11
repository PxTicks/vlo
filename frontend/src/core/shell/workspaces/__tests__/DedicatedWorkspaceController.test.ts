import { describe, expect, it, vi } from "vitest";
import { HostContextKeyService } from "../../contextKeys";
import { EditorSurfaceRegistry } from "../../editorSurfaces";
import { describeEditorSurfaces, describeShellPanels } from "../../layout/layoutDescriptors";
import { createMemoryShellLayoutPersistence } from "../../layout/layoutPersistence";
import { createShellLayoutStore } from "../../layout/useShellLayoutStore";
import type { ShellLayoutDocumentV2 } from "../../layout/layoutTypes";
import { HostViewRegistry } from "../../viewRegistry";
import { DedicatedWorkspaceController } from "../DedicatedWorkspaceController";
import { DedicatedWorkspaceRegistry } from "../DedicatedWorkspaceRegistry";
import type {
  DedicatedWorkspaceDefinition,
  DedicatedWorkspaceSession,
} from "../workspaceTypes";

interface Subject extends Record<string, string> {
  clipId: string;
}

const BASE_DOCUMENT: ShellLayoutDocumentV2 = {
  version: 2,
  panels: {},
  regions: { "right-sidebar": { sizePx: 380 } },
  workspaceLayouts: {},
};

function createHarness(document: ShellLayoutDocumentV2 = BASE_DOCUMENT) {
  const contextKeys = new HostContextKeyService();
  const views = new HostViewRegistry(contextKeys, null);
  const surfaces = new EditorSurfaceRegistry(contextKeys);
  const registry = new DedicatedWorkspaceRegistry();
  const registrations = [
    views.registerHostView({
      id: "host.left",
      title: "Left",
      defaultRegion: "left-sidebar",
      component: () => null,
    }),
    views.registerHostView({
      id: "host.right",
      title: "Right",
      defaultRegion: "right-sidebar",
      component: () => null,
    }),
    views.registerHostView({
      id: "host.aside",
      title: "Aside",
      defaultRegion: "player-aside",
      component: () => null,
    }),
    views.registerHostView({
      id: "host.scopes",
      title: "Scopes",
      defaultRegion: "bottom-dock",
      allowedRegions: ["bottom-dock", "right-sidebar"],
      component: () => null,
    }),
    surfaces.register({
      id: "host.player",
      title: "Player",
      defaultStage: "main-stage",
      order: 0,
      component: () => null,
    }),
    surfaces.register({
      id: "host.preview",
      title: "Preview",
      defaultStage: "main-stage",
      order: 10,
      component: () => null,
    }),
    surfaces.register({
      id: "host.timeline",
      title: "Timeline",
      defaultStage: "lower-stage",
      order: 0,
      component: () => null,
    }),
    surfaces.register({
      id: "host.tools",
      title: "Tools",
      defaultStage: "lower-stage",
      order: 10,
      component: () => null,
    }),
  ];
  const persistence = createMemoryShellLayoutPersistence(document);
  const store = createShellLayoutStore({
    persistence,
    panels: describeShellPanels(views),
    surfaces: describeEditorSurfaces(surfaces),
  });
  const controller = new DedicatedWorkspaceController({
    registry,
    views,
    surfaces,
    layoutStore: store,
  });
  return { controller, registry, registrations, store, persistence };
}

function workspace(
  createSession: DedicatedWorkspaceDefinition<Subject>["createSession"],
  overrides: Partial<DedicatedWorkspaceDefinition<Subject>> = {},
): DedicatedWorkspaceDefinition<Subject> {
  return {
    id: "host.fixture",
    title: "Fixture",
    ownerId: "host.fixture",
    subjectSchema: {
      validate: (value): value is Subject =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.clipId === "string",
    },
    describeSubject: (subject) => `Clip ${subject.clipId}`,
    composition: {
      stages: {
        "main-stage": { surfaceId: "host.preview", required: true },
        "lower-stage": { surfaceId: "host.tools", required: true },
      },
      docks: {
        "left-sidebar": {
          mode: "replace",
          panels: [{ viewId: "host.left", required: true }],
        },
        "right-sidebar": {
          mode: "replace",
          panels: [{ viewId: "host.right", required: true }],
        },
        "player-aside": {
          mode: "replace",
          panels: [{ viewId: "host.aside", required: true }],
        },
        "bottom-dock": {
          mode: "replace",
          panels: [{ viewId: "host.scopes", required: true }],
        },
      },
    },
    createSession,
    ...overrides,
  };
}

describe("DedicatedWorkspaceController", () => {
  it("replaces both stages and composes all docks in one layout transaction", async () => {
    const harness = createHarness();
    const dispose = vi.fn();
    harness.registry.register(workspace(() => ({ dispose })));
    const layoutListener = vi.fn();
    harness.store.subscribe(layoutListener);
    const subject = { clipId: "a" };

    await expect(harness.controller.enter("host.fixture", subject)).resolves.toEqual({
      status: "opened",
    });
    subject.clipId = "mutated";

    expect(layoutListener).toHaveBeenCalledTimes(1);
    expect(harness.store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.preview",
    );
    expect(harness.store.getState().resolved.stages["lower-stage"].surfaceId).toBe(
      "host.tools",
    );
    expect(
      Object.values(harness.store.getState().resolved.regions).map(
        (region) => region.selectedViewId,
      ),
    ).toEqual(["host.left", "host.right", "host.aside", "host.scopes"]);
    expect(harness.controller.getSnapshot().active?.subject).toEqual({ clipId: "a" });
    expect(harness.persistence.writeCount).toBe(0);

    harness.controller.dispose();
  });

  it("restores the current valid base layout and keeps session changes transient", async () => {
    const harness = createHarness();
    harness.registry.register(workspace(() => ({ dispose: vi.fn() })));
    await harness.controller.enter("host.fixture", { clipId: "a" });

    harness.store.getState().resizeRegion("right-sidebar", 460);
    harness.store.getState().movePanel("host.scopes", "right-sidebar");
    expect(harness.store.getState().document.regions["right-sidebar"]?.sizePx).toBe(
      380,
    );
    expect(harness.persistence.writeCount).toBe(0);

    await expect(harness.controller.exit()).resolves.toBe(true);
    expect(harness.store.getState().resolved.regions["right-sidebar"].sizePx).toBe(
      380,
    );
    expect(harness.store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.player",
    );
    expect(harness.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
    harness.controller.dispose();
  });

  it("restores the stage composition that was active before entry", async () => {
    const harness = createHarness();
    harness.registry.register(workspace(() => ({ dispose: vi.fn() })));
    harness.store
      .getState()
      .setStageSurface("main-stage", "host.preview");
    await harness.controller.enter("host.fixture", { clipId: "a" });
    harness.store.getState().setStageSurface("main-stage", "host.player");

    await harness.controller.exit();

    expect(harness.store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.preview",
    );
    expect(harness.store.getState().stageSurfaces).toEqual({
      "main-stage": "host.preview",
    });
    harness.controller.dispose();
  });

  it("resets a workspace to its composition without ending the session", async () => {
    const harness = createHarness();
    harness.registry.register(workspace(() => ({ dispose: vi.fn() })));
    await harness.controller.enter("host.fixture", { clipId: "a" });
    harness.store.getState().movePanel("host.scopes", "right-sidebar");
    harness.store.getState().resizeRegion("left-sidebar", 300);

    harness.store.getState().resetRegion("right-sidebar");
    expect(harness.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
    expect(harness.store.getState().resolved.regions["left-sidebar"].sizePx).toBe(
      300,
    );
    expect(harness.store.getState().activeWorkspaceLayout).not.toBeNull();

    harness.store.getState().setStageSurface("main-stage", "host.player");
    harness.store.getState().movePanel("host.scopes", "right-sidebar");
    harness.store.getState().resetLayout();
    expect(harness.store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.preview",
    );
    expect(harness.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
    expect(harness.store.getState().activeWorkspaceLayout).not.toBeNull();
    harness.controller.dispose();
  });

  it("saves and clears workspace overrides explicitly", async () => {
    const harness = createHarness();
    harness.registry.register(workspace(() => ({ dispose: vi.fn() })));
    await harness.controller.enter("host.fixture", { clipId: "a" });
    harness.store.getState().resizeRegion("right-sidebar", 455);
    harness.store.getState().movePanel("host.scopes", "right-sidebar");

    expect(harness.controller.saveLayoutOverride()).toBe(true);
    expect(
      harness.store.getState().document.workspaceLayouts["host.fixture"].regions[
        "right-sidebar"
      ]?.sizePx,
    ).toBe(455);
    expect(harness.persistence.current.workspaceLayouts["host.fixture"]).toBeDefined();
    expect(
      Object.keys(
        harness.persistence.current.workspaceLayouts["host.fixture"].panels,
      ),
    ).toEqual(["host.scopes"]);
    await harness.controller.exit();
    await harness.controller.enter("host.fixture", { clipId: "a" });
    expect(harness.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "right-sidebar",
    );

    expect(harness.controller.clearLayoutOverride()).toBe(true);
    expect(
      harness.store.getState().document.workspaceLayouts["host.fixture"],
    ).toBeUndefined();
    expect(harness.store.getState().resolved.regions["right-sidebar"].sizePx).toBe(
      380,
    );
    expect(harness.store.getState().resolved.panelRegions["host.scopes"]).toBe(
      "bottom-dock",
    );
    harness.controller.dispose();
  });

  it("leaves the prior editor untouched when validation or creation fails", async () => {
    const harness = createHarness();
    const before = harness.store.getState().resolved;
    harness.registry.register(
      workspace(() => ({ dispose: vi.fn() }), {
        composition: {
          stages: {
            "main-stage": { surfaceId: "host.missing", required: true },
          },
        },
      }),
    );

    const result = await harness.controller.enter("host.fixture", { clipId: "a" });
    expect(result.status).toBe("failed");
    expect(harness.store.getState().resolved).toBe(before);
    expect(harness.controller.getSnapshot().active).toBeNull();
    harness.controller.dispose();
  });

  it("keeps the active workspace intact when a switch fails to create", async () => {
    const harness = createHarness();
    const firstDispose = vi.fn();
    harness.registry.register(workspace(() => ({ dispose: firstDispose })));
    harness.registry.register(
      workspace(
        () => {
          throw new Error("could not prepare");
        },
        { id: "host.second", ownerId: "host.second" },
      ),
    );
    await harness.controller.enter("host.fixture", { clipId: "a" });
    const before = harness.store.getState().resolved;

    const result = await harness.controller.enter("host.second", { clipId: "b" });

    expect(result.status).toBe("failed");
    expect(harness.controller.getSnapshot().active?.id).toBe("host.fixture");
    expect(harness.store.getState().resolved).toBe(before);
    expect(firstDispose).not.toHaveBeenCalled();
    await harness.controller.exit({ force: true });
    harness.controller.dispose();
  });

  it("honours dirty close cancellation", async () => {
    const harness = createHarness();
    const requestClose = vi.fn().mockResolvedValue("cancel");
    harness.registry.register(
      workspace(() => ({ dirty: true, requestClose, dispose: vi.fn() })),
    );
    await harness.controller.enter("host.fixture", { clipId: "a" });

    await expect(harness.controller.exit()).resolves.toBe(false);
    expect(requestClose).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().active?.id).toBe("host.fixture");
    await harness.controller.exit({ force: true });
    harness.controller.dispose();
  });

  it("force-closes on owner removal and subject invalidation", async () => {
    const harness = createHarness();
    const session: DedicatedWorkspaceSession = { dispose: vi.fn() };
    const registration = harness.registry.register(workspace(() => session));
    await harness.controller.enter("host.fixture", { clipId: "a" });

    registration.dispose();
    await vi.waitFor(() => {
      expect(harness.controller.getSnapshot().active).toBeNull();
    });
    expect(session.dispose).toHaveBeenCalledOnce();

    const second = harness.registry.register(workspace(() => ({ dispose: vi.fn() })));
    await harness.controller.enter("host.fixture", { clipId: "b" });
    await expect(harness.controller.invalidateSubject("host.fixture")).resolves.toBe(
      true,
    );
    expect(harness.controller.getSnapshot().active).toBeNull();
    second.dispose();
    harness.controller.dispose();
  });

  it("aborts and disposes an activation superseded before it commits", async () => {
    const harness = createHarness();
    let resolveSession: ((session: DedicatedWorkspaceSession) => void) | undefined;
    let activationSignal: AbortSignal | undefined;
    const dispose = vi.fn();
    harness.registry.register(
      workspace(
        (_subject, context) => {
          activationSignal = context.signal;
          return new Promise((resolve) => {
            resolveSession = resolve;
          });
        },
      ),
    );

    const opening = harness.controller.enter("host.fixture", { clipId: "a" });
    await vi.waitFor(() => expect(activationSignal).toBeDefined());
    await harness.controller.exit();
    expect(activationSignal?.aborted).toBe(true);
    resolveSession?.({ dispose });

    await expect(opening).resolves.toEqual({ status: "cancelled" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(harness.store.getState().activeWorkspaceLayout).toBeNull();
    harness.controller.dispose();
  });

  it("invalidates only the matching pending subject and preserves another active workspace", async () => {
    const harness = createHarness();
    const activeDispose = vi.fn();
    let resolvePending: ((session: DedicatedWorkspaceSession) => void) | undefined;
    let pendingSignal: AbortSignal | undefined;
    harness.registry.register(workspace(() => ({ dispose: activeDispose })));
    harness.registry.register(
      workspace(
        (_subject, context) => {
          pendingSignal = context.signal;
          return new Promise((resolve) => {
            resolvePending = resolve;
          });
        },
        { id: "host.second", ownerId: "host.second" },
      ),
    );
    await harness.controller.enter("host.fixture", { clipId: "active" });

    const opening = harness.controller.enter("host.second", {
      clipId: "pending",
    });
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());

    await expect(
      harness.controller.invalidateSubject(
        "host.second",
        (subject) =>
          typeof subject === "object" &&
          subject !== null &&
          !Array.isArray(subject) &&
          subject.clipId === "pending",
      ),
    ).resolves.toBe(true);
    expect(pendingSignal?.aborted).toBe(true);
    expect(harness.controller.getSnapshot().active?.id).toBe("host.fixture");
    expect(activeDispose).not.toHaveBeenCalled();

    resolvePending?.({ dispose: vi.fn() });
    await expect(opening).resolves.toEqual({ status: "cancelled" });
    await harness.controller.exit({ force: true });
    harness.controller.dispose();
  });

  it("revalidates required surfaces after async creation and while active", async () => {
    const pending = createHarness();
    let resolveSession: ((session: DedicatedWorkspaceSession) => void) | undefined;
    const pendingDispose = vi.fn();
    pending.registry.register(
      workspace(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      ),
    );
    const opening = pending.controller.enter("host.fixture", { clipId: "a" });
    await vi.waitFor(() => expect(resolveSession).toBeDefined());
    pending.registrations[5].dispose();
    resolveSession?.({ dispose: pendingDispose });

    const failed = await opening;
    expect(failed.status).toBe("failed");
    expect(pendingDispose).toHaveBeenCalledOnce();
    expect(pending.controller.getSnapshot().active).toBeNull();
    expect(pending.store.getState().resolved.stages["main-stage"].surfaceId).toBe(
      "host.player",
    );
    pending.controller.dispose();

    const active = createHarness();
    const activeDispose = vi.fn();
    active.registry.register(workspace(() => ({ dispose: activeDispose })));
    await active.controller.enter("host.fixture", { clipId: "b" });
    active.registrations[5].dispose();
    await vi.waitFor(() => {
      expect(active.controller.getSnapshot().active).toBeNull();
    });
    expect(activeDispose).toHaveBeenCalledOnce();
    active.controller.dispose();
  });

  it("moves focus into the workspace and restores the invocation target", async () => {
    const harness = createHarness();
    const invocation = globalThis.document.createElement("button");
    const stage = globalThis.document.createElement("div");
    stage.tabIndex = -1;
    stage.dataset.shellStage = "main-stage";
    globalThis.document.body.append(invocation, stage);
    invocation.focus();
    harness.registry.register(
      workspace(() => ({ dispose: vi.fn() }), {
        initialFocus: { kind: "stage", stage: "main-stage" },
      }),
    );

    await harness.controller.enter("host.fixture", { clipId: "a" }, invocation);
    await Promise.resolve();
    expect(globalThis.document.activeElement).toBe(stage);

    await harness.controller.exit();
    await Promise.resolve();
    expect(globalThis.document.activeElement).toBe(invocation);
    invocation.remove();
    stage.remove();
    harness.controller.dispose();
  });
});
