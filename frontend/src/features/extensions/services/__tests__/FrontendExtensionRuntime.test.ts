import { describe, expect, it, vi } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { ExtensionContributionRegistry } from "../../registry/ExtensionContributionRegistry";
import type { ExtensionContributionDefinition } from "../../registry/ExtensionContributionRegistry";
import type { ExtensionInventoryItem } from "../extensionManagementApi";
import {
  createVloExtensionApi,
  FrontendExtensionInventoryTimeoutError,
  FrontendExtensionRuntime,
} from "../FrontendExtensionRuntime";
import type { VloExtensionApi } from "../../types";
import { extensionTransformationRegistry } from "../../../transformations/extensionApi";
import { extensionUiSlotRegistry } from "../../ui/ExtensionUiSlotRegistry";
import { Filter } from "pixi.js";
import { createElement } from "react";

interface TestContribution extends ExtensionContributionDefinition {
  value: string;
}

interface TestApi {
  register(definition: TestContribution): void;
}

function inventoryItem(
  id: string,
  options: {
    status?: ExtensionInventoryItem["status"];
    sdk?: string;
    frontend?: boolean;
    backend?: boolean;
    backendStatus?: ExtensionInventoryItem["backendRuntime"]["status"];
  } = {},
): ExtensionInventoryItem {
  const status = options.status ?? "approved";
  const digest = `sha256:${id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`;
  const frontend = options.frontend ?? true;
  return {
    id,
    sourcePath: `/extensions/${id}`,
    status,
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      sdk: options.sdk ?? ">=1.0.0 <2.0.0",
      ...(frontend ? { frontend: { entry: "frontend/dist/index.js" } } : {}),
      ...(!frontend || options.backend
        ? {
            backend: {
              mode: "in_process" as const,
              entry: "backend.extension:create_extension",
            },
          }
        : {}),
      capabilities: [],
    },
    approval:
      status === "approved"
        ? {
            digest,
            version: "1.0.0",
            approvedAt: 1,
            enabled: true,
          }
        : null,
    backendRuntime: {
      status: options.backend
        ? (options.backendStatus ?? "restart_required")
        : "not_declared",
      message: options.backend
        ? "Backend readiness test state."
        : "No backend entry point is declared.",
      digest: options.backend ? digest : null,
    },
    frontendEntryUrl: frontend
      ? `/app/extensions/${id}/frontend/${digest}/index.js`
      : null,
  };
}

function createHarness(
  inventory: ExtensionInventoryItem[],
  importModule: (url: string) => Promise<unknown>,
) {
  const registry = new ExtensionContributionRegistry<TestContribution>(
    "runtime.test",
  );
  const host = new ExtensionHost<TestApi>({
    sdkVersion: "1.0.0",
    createApi: (scope) => {
      const registrations = registry.bind(scope);
      return {
        register: (definition) => {
          registrations.register(definition);
        },
      };
    },
  });
  const runtime = new FrontendExtensionRuntime({
    host,
    loadInventory: async () => inventory,
    importModule,
  });
  return { host, registry, runtime };
}

describe("FrontendExtensionRuntime", () => {
  it("activates and disposes production transformation and UI facades", async () => {
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.0.0",
      createApi: createVloExtensionApi,
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => [inventoryItem("example.color-grade")],
      importModule: async () => ({
        activate: (context: { api: VloExtensionApi }) => {
          expect(context.api.runtime.pixi.Filter).toBe(Filter);
          expect(context.api.runtime.react.createElement).toBe(createElement);
          context.api.transformations.register({
            id: "film-grade",
            apiVersion: 1,
            kind: "host-filter",
            hostFilter: "hsl-adjustment",
            label: "Film Grade",
            groups: [
              {
                id: "grade",
                title: "Grade",
                controls: [
                  {
                    type: "slider",
                    name: "hue",
                    label: "Hue",
                    defaultValue: 0,
                    min: -180,
                    max: 180,
                  },
                ],
              },
            ],
          });
          context.api.ui.registerNotice({
            id: "help",
            apiVersion: 1,
            slot: "transformation-panel.before",
            kind: "notice",
            title: "Film Grade",
            message: "Choose Film Grade from the Add menu.",
          });
        },
      }),
    });

    const summary = await runtime.start();

    try {
      expect(summary.results[0]?.status).toBe("active");
      expect(
        extensionTransformationRegistry
          .listDefinitions()
          .some(
            (definition) =>
              definition.filterName === "example.color-grade/film-grade",
          ),
      ).toBe(true);
      expect(
        extensionUiSlotRegistry
          .list("transformation-panel.before")
          .map((entry) => entry.id),
      ).toContain("example.color-grade/help");
    } finally {
      await host.deactivate("example.color-grade");
    }
    expect(
      extensionTransformationRegistry
        .listDefinitions()
        .some(
          (definition) =>
            definition.filterName === "example.color-grade/film-grade",
        ),
    ).toBe(false);
    expect(
      extensionUiSlotRegistry
        .list("transformation-panel.before")
        .map((entry) => entry.id),
    ).not.toContain("example.color-grade/help");
  });

  it("imports and activates only approved frontend packages", async () => {
    const activate = vi.fn();
    const importModule = vi.fn(async () => ({ activate }));
    const { host, runtime } = createHarness(
      [
        inventoryItem("example.pending", { status: "pending_approval" }),
        inventoryItem("example.disabled", { status: "disabled" }),
        inventoryItem("example.backend", { frontend: false }),
        inventoryItem("example.approved"),
      ],
      importModule,
    );

    const summary = await runtime.start();

    expect(importModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith(
      expect.stringContaining("example.approved"),
    );
    expect(activate).toHaveBeenCalledOnce();
    expect(host.getState("example.approved")?.status).toBe("active");
    expect(host.getState("example.pending")).toBeUndefined();
    expect(summary.results).toEqual([
      expect.objectContaining({
        extensionId: "example.approved",
        status: "active",
      }),
    ]);
  });

  it("fails closed before import for incompatible SDK ranges", async () => {
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const { runtime } = createHarness(
      [inventoryItem("example.future", { sdk: ">=2.0.0" })],
      importModule,
    );

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      extensionId: "example.future",
      status: "incompatible",
      stage: "compatibility",
    });
  });

  it("waits for backend readiness before importing a combined package", async () => {
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const { runtime } = createHarness(
      [inventoryItem("example.combined", { backend: true })],
      importModule,
    );

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      extensionId: "example.combined",
      status: "waiting_backend",
      stage: "backend",
      message: expect.stringContaining("Backend readiness test state"),
    });
  });

  it("activates a combined package after backend readiness is confirmed", async () => {
    const activate = vi.fn();
    const importModule = vi.fn(async () => ({ activate }));
    const { runtime } = createHarness(
      [
        inventoryItem("example.combined-ready", {
          backend: true,
          backendStatus: "active",
        }),
      ],
      importModule,
    );

    const summary = await runtime.start();

    expect(importModule).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(summary.results[0]?.status).toBe("active");
  });

  it("waits when backend readiness refers to a different digest", async () => {
    const item = inventoryItem("example.combined-stale", {
      backend: true,
      backendStatus: "active",
    });
    item.backendRuntime.digest = `sha256:${"f".repeat(64)}`;
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const { runtime } = createHarness([item], importModule);

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: "waiting_backend",
      stage: "backend",
    });
  });

  it("isolates import and activation failures and rolls back registrations", async () => {
    const items = [
      inventoryItem("example.import-failure"),
      inventoryItem("example.activation-failure"),
      inventoryItem("example.healthy"),
    ];
    const importModule = vi.fn(async (url: string) => {
      if (url.includes("import-failure")) {
        throw new Error("module parse failed");
      }
      return {
        activate: (context: { api: TestApi }) => {
          context.api.register({ id: "healthy", apiVersion: 1, value: "kept" });
        },
      };
    });
    const { host, registry, runtime } = createHarness(items, async (url) => {
      if (url.includes("activation-failure")) {
        return {
          activate: (context: { api: TestApi }) => {
            context.api.register({
              id: "partial",
              apiVersion: 1,
              value: "rolled back",
            });
            throw new Error("activation failed");
          },
        };
      }
      return importModule(url);
    });

    const summary = await runtime.start();

    expect(summary.results.map((result) => result.status)).toEqual([
      "failed",
      "failed",
      "active",
    ]);
    expect(host.getState("example.activation-failure")?.status).toBe("failed");
    expect(host.getState("example.healthy")?.status).toBe("active");
    expect(registry.has("example.activation-failure/partial")).toBe(false);
    expect(registry.has("example.healthy/healthy")).toBe(true);
  });

  it("rejects modules without a named activate export", async () => {
    const { runtime } = createHarness(
      [inventoryItem("example.invalid-module")],
      async () => ({ default: { activate: vi.fn() } }),
    );

    const summary = await runtime.start();

    expect(summary.results[0]).toMatchObject({
      status: "failed",
      stage: "validation",
      message: expect.stringContaining("export an activate"),
    });
  });

  it("is single-flight when startup is requested more than once", async () => {
    const loadInventory = vi.fn(async () => [inventoryItem("example.once")]);
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const host = new ExtensionHost<Record<string, never>>({
      sdkVersion: "1.0.0",
      createApi: () => ({}),
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory,
      importModule,
    });

    const [first, second] = await Promise.all([runtime.start(), runtime.start()]);

    expect(first).toBe(second);
    expect(loadInventory).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledOnce();
  });

  it("fails closed on inventory errors without rejecting app startup", async () => {
    const importModule = vi.fn();
    const host = new ExtensionHost<Record<string, never>>({
      sdkVersion: "1.0.0",
      createApi: () => ({}),
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => {
        throw new Error("inventory unavailable");
      },
      importModule,
    });

    const summary = await runtime.start();

    expect(summary.inventoryLoaded).toBe(false);
    expect(summary.inventoryError).toEqual(new Error("inventory unavailable"));
    expect(importModule).not.toHaveBeenCalled();
  });

  it("aborts a hung inventory request so app startup can continue", async () => {
    vi.useFakeTimers();
    try {
      const host = new ExtensionHost<Record<string, never>>({
        sdkVersion: "1.0.0",
        createApi: () => ({}),
      });
      let inventorySignal: AbortSignal | undefined;
      const runtime = new FrontendExtensionRuntime({
        host,
        inventoryTimeoutMs: 50,
        loadInventory: (signal) => {
          inventorySignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
        importModule: vi.fn(),
      });

      const startup = runtime.start();
      await vi.advanceTimersByTimeAsync(50);
      const summary = await startup;

      expect(inventorySignal?.aborted).toBe(true);
      expect(summary.inventoryLoaded).toBe(false);
      expect(summary.inventoryError).toBeInstanceOf(
        FrontendExtensionInventoryTimeoutError,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
