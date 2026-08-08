import { describe, expect, it, vi } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { ExtensionContributionRegistry } from "../../registry/ExtensionContributionRegistry";
import type { ExtensionContributionDefinition } from "../../registry/ExtensionContributionRegistry";
import type { ExtensionInventoryItem } from "../extensionManagementApi";
import { ExtensionPeerRegistry } from "../../peers/ExtensionPeerRegistry";
import {
  createVloExtensionApi,
  FrontendExtensionInventoryTimeoutError,
  FrontendExtensionRuntime,
  type FrontendExtensionStartResult,
} from "../FrontendExtensionRuntime";
import type { VloExtensionApi } from "../../types";
import { extensionTransformationRegistry } from "../../../transformations/extensionApi";
import { extensionTransitionRegistry } from "../../../transitions/extensions/ExtensionTransitionRegistry";
import { extensionUiSlotRegistry } from "../../ui/ExtensionUiSlotRegistry";
import { Container, Filter } from "pixi.js";
import { createElement } from "react";
import { extensionEntityProviderRegistry } from "../../entities/publicApi";
import { extensionParameterPresetRegistry } from "../../registry/publicApi";
import { Button } from "@mui/material";
import { VLO_APP_VERSION } from "../../../project/constants";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";
import {
  PanelSection,
  getCustomControl,
  registerCustomControl,
} from "../../../panelUI";

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
    vlo?: string;
    frontend?: boolean;
    declarative?: boolean;
    backend?: boolean;
    backendStatus?: ExtensionInventoryItem["backendRuntime"]["status"];
    version?: string;
    activationEvents?: readonly string[];
    dependencies?: Readonly<Record<string, string>>;
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
      version: options.version ?? "1.0.0",
      sdk: options.sdk ?? ">=1.0.0 <2.0.0",
      ...(options.activationEvents
        ? { activationEvents: [...options.activationEvents] }
        : {}),
      ...(options.dependencies ? { dependencies: { ...options.dependencies } } : {}),
      ...(options.vlo ? { vlo: options.vlo } : {}),
      ...(frontend ? { frontend: { entry: "frontend/dist/index.js" } } : {}),
      ...((!frontend && !options.declarative) || options.backend
        ? {
            backend: {
              mode: "in_process" as const,
              entry: "backend.extension:create_extension",
            },
          }
        : {}),
      capabilities: [],
      ...(options.declarative
        ? { contributions: { luts: "luts.json" } }
        : {}),
    },
    approval:
      status === "approved"
        ? {
            digest,
            version: options.version ?? "1.0.0",
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
    preflight: null,
    ...(options.declarative
      ? {
          lutContributions: [
            {
              id: "look",
              label: "Look",
              description: null,
              order: 0,
              resourceUrl: `/app/extensions/${id}/resources/${digest}/resources/look.cube`,
            },
          ],
        }
      : {}),
  };
}

interface HarnessOptions {
  peers?: ExtensionPeerRegistry;
  isProjectOpen?: () => boolean;
  subscribeProjectOpen?: (listener: () => void) => () => void;
  onResult?: (result: FrontendExtensionStartResult) => void;
}

function createHarness(
  inventory: ExtensionInventoryItem[],
  importModule: (url: string) => Promise<unknown>,
  options: HarnessOptions = {},
) {
  const registry = new ExtensionContributionRegistry<TestContribution>(
    "runtime.test",
  );
  const peers = options.peers ?? new ExtensionPeerRegistry();
  const host = new ExtensionHost<TestApi>({
    sdkVersion: "1.0.0",
    onExport: (identity, api) => {
      if (api === undefined) peers.retract(identity.id);
      else peers.publishApi(identity.id, api);
    },
    createApi: (scope) => {
      const registrations = registry.bind(scope);
      return {
        register: (definition: TestContribution) => {
          registrations.register(definition);
        },
        peers: peers.bind(scope),
      } as unknown as TestApi;
    },
  });
  const runtime = new FrontendExtensionRuntime({
    host,
    loadInventory: async () => inventory,
    importModule,
    peers,
    ...(options.onResult ? { onResult: options.onResult } : {}),
    isProjectOpen: options.isProjectOpen ?? (() => false),
    ...(options.subscribeProjectOpen
      ? { subscribeProjectOpen: options.subscribeProjectOpen }
      : { subscribeProjectOpen: () => () => undefined }),
  });
  return { host, registry, runtime, peers };
}

describe("FrontendExtensionRuntime", () => {
  it("does not treat code-free declarative packages as activation candidates", async () => {
    const item = inventoryItem("example.looks", {
      frontend: false,
      declarative: true,
    });
    const importModule = vi.fn();
    const { host, runtime } = createHarness([item], importModule);

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results).toEqual([]);
    expect(host.getState(item.id)).toBeUndefined();
  });

  it("rolls trusted patches back on activation failure and deactivation", async () => {
    const target = { value: "original" };
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.3.0",
      createApi: createVloExtensionApi,
    });
    const install = (context: { api: VloExtensionApi }) => {
      context.api.trusted.host.patchProperty(target, "value", (previous) => ({
        ...previous,
        configurable: true,
        value: "patched",
      }));
    };

    await host.activate(
      { id: "example.patch-active", version: "1.0.0" },
      { activate: install },
    );
    expect(target.value).toBe("patched");
    expect(host.getDiagnostics("example.patch-active")).toContainEqual(
      expect.objectContaining({
        level: "debug",
        message: "Trusted host access used.",
        detail: { hostVersion: VLO_APP_VERSION },
      }),
    );
    await host.deactivate("example.patch-active");
    expect(target.value).toBe("original");

    await expect(
      host.activate(
        { id: "example.patch-failed", version: "1.0.0" },
        {
          activate: (context) => {
            install(context);
            throw new Error("activation failed");
          },
        },
      ),
    ).rejects.toThrow("Failed to activate");
    expect(target.value).toBe("original");
  });

  it("activates and disposes production transformation and UI facades", async () => {
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: VLO_EXTENSION_SDK_VERSION,
      createApi: createVloExtensionApi,
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => [inventoryItem("example.color-grade")],
      importModule: async () => ({
        activate: (context: { api: VloExtensionApi }) => {
          expect(context.api.runtime.pixi.Filter).toBe(Filter);
          expect(context.api.runtime.react.createElement).toBe(createElement);
          expect(context.api.runtime.mui.Button).toBe(Button);
          expect(context.api.runtime.panelUi.PanelSection).toBe(PanelSection);
          expect(context.api.runtime.panelUi.registerCustomControl).toBe(
            registerCustomControl,
          );
          expect(context.api.runtime.panelUi.getCustomControl).toBe(
            getCustomControl,
          );
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
          context.api.transformations.presets.register({
            id: "muted-look",
            apiVersion: 1,
            label: "Muted look",
            target: { kind: "filter", filterName: "ColorGradeFilter" },
            parameters: { saturation: 0.7 },
          });
          context.api.ui.registerNotice({
            id: "help",
            apiVersion: 1,
            slot: "transformation-panel.before",
            kind: "notice",
            title: "Film Grade",
            message: "Choose Film Grade from the Add menu.",
          });
          context.api.entityProviders.register({
            id: "grade-card",
            apiVersion: 1,
            kind: "trusted-pixi",
            label: "Grade card",
            schemaVersion: 1,
            defaultPayload: { color: "#334155" },
            validate: () => undefined,
            createRenderable: () => ({
              object: new Container(),
              update: () => undefined,
            }),
          });
          context.api.transitions.register({
            id: "fade-through-grade",
            apiVersion: 1,
            label: "Fade through grade",
            glyph: "F",
            schemaVersion: 1,
            groups: [
              {
                id: "appearance",
                title: "Appearance",
                controls: [
                  {
                    type: "color",
                    name: "color",
                    label: "Color",
                    defaultValue: "#112233",
                  },
                ],
              },
            ],
            renderFrame: ({ parameters }) => ({
              colorLayers: [
                {
                  color:
                    typeof parameters.color === "string"
                      ? parameters.color
                      : "#112233",
                },
              ],
            }),
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
      expect(
        extensionEntityProviderRegistry.get({
          extensionId: "example.color-grade",
          typeId: "grade-card",
          schemaVersion: 1,
          data: {},
        }),
      ).toBeDefined();
      expect(
        extensionTransitionRegistry
          .listDefinitions()
          .some(
            (definition) =>
              definition.type === "example.color-grade/fade-through-grade",
          ),
      ).toBe(true);
      expect(
        extensionParameterPresetRegistry
          .list({ kind: "filter", filterName: "ColorGradeFilter" })
          .map((preset) => preset.id),
      ).toContain("example.color-grade/muted-look");
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
    expect(
      extensionEntityProviderRegistry.get({
        extensionId: "example.color-grade",
        typeId: "grade-card",
        schemaVersion: 1,
        data: {},
      }),
    ).toBeUndefined();
    expect(
      extensionTransitionRegistry
        .listDefinitions()
        .some(
          (definition) =>
            definition.type === "example.color-grade/fade-through-grade",
        ),
    ).toBe(false);
    expect(
      extensionParameterPresetRegistry
        .list({ kind: "filter", filterName: "ColorGradeFilter" })
        .map((preset) => preset.id),
    ).not.toContain("example.color-grade/muted-look");
  });

  it("rolls parameter presets back when activation later fails", async () => {
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: VLO_EXTENSION_SDK_VERSION,
      createApi: createVloExtensionApi,
    });

    await expect(
      host.activate(
        { id: "example.failed-preset", version: "1.0.0" },
        {
          activate: (context) => {
            context.api.transformations.presets.register({
              id: "temporary-look",
              apiVersion: 1,
              label: "Temporary look",
              target: { kind: "filter", filterName: "ColorGradeFilter" },
              parameters: { contrast: 1.1 },
            });
            throw new Error("activation failed");
          },
        },
      ),
    ).rejects.toThrow("Failed to activate");

    expect(
      extensionParameterPresetRegistry
        .list({ kind: "filter", filterName: "ColorGradeFilter" })
        .map((preset) => preset.id),
    ).not.toContain("example.failed-preset/temporary-look");
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

  it("rejects a frontend package with no staged entry URL before compatibility or import", async () => {
    const item = inventoryItem("example.missing-entry", { sdk: ">=2.0.0" });
    item.frontendEntryUrl = null;
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const { runtime } = createHarness([item], importModule);

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      stage: "validation",
      message: expect.stringContaining("content-addressed entry URL"),
    });
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

  it("fails before import for an incompatible known VLO range", async () => {
    const item = inventoryItem("example.future-vlo", { vlo: ">=0.3.0" });
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const host = new ExtensionHost<Record<string, never>>({
      sdkVersion: "1.0.0",
      hostVersion: "0.2.0",
      createApi: () => ({}),
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => [item],
      importModule,
    });

    const summary = await runtime.start();

    expect(importModule).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      status: "incompatible",
      stage: "compatibility",
      message: expect.stringContaining("VLO application 0.2.0"),
    });
  });

  it("warns and activates when the VLO build version is unknown", async () => {
    const warning = vi.fn();
    const importModule = vi.fn(async () => ({ activate: vi.fn() }));
    const host = new ExtensionHost<Record<string, never>>({
      sdkVersion: "1.0.0",
      hostVersion: null,
      createApi: () => ({}),
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      onCompatibilityWarning: warning,
      loadInventory: async () => [
        inventoryItem("example.unknown-vlo", { vlo: ">=0.2.0 <0.3.0" }),
      ],
      importModule,
    });

    const summary = await runtime.start();

    expect(summary.results[0]?.status).toBe("active");
    expect(warning).toHaveBeenCalledWith(
      "example.unknown-vlo",
      expect.stringContaining("could not be verified"),
    );
  });

  it("shares the host version between compatibility and the trusted API", async () => {
    const hostVersion = "0.2.7";
    let trustedApiHostVersion: string | null | undefined;
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.0.0",
      hostVersion,
      createApi: createVloExtensionApi,
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => [
        inventoryItem("example.shared-host-version", {
          vlo: ">=0.2.7 <0.3.0",
        }),
      ],
      importModule: async () => ({
        activate: (context: { api: VloExtensionApi }) => {
          trustedApiHostVersion = context.api.trusted.host.hostVersion;
        },
      }),
    });

    const summary = await runtime.start();

    expect(summary.results[0]?.status).toBe("active");
    expect(trustedApiHostVersion).toBe(hostVersion);
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

describe("FrontendExtensionRuntime activation events and dependencies", () => {
  /** Results keyed by extension, so ordering differences do not mask content. */
  function byId(
    results: readonly FrontendExtensionStartResult[],
  ): Record<string, FrontendExtensionStartResult> {
    return Object.fromEntries(
      results.map((result) => [result.extensionId, result]),
    );
  }

  /** Maps `/app/extensions/<id>/...` back to a per-extension module. */
  function importerFor(
    modules: Readonly<Record<string, { activate: (context: never) => unknown }>>,
    order: string[] = [],
  ) {
    return async (url: string) => {
      const id = url.split("/")[3];
      const module = modules[id];
      if (!module) throw new Error(`No test module for '${id}'.`);
      return {
        activate: (context: never) => {
          order.push(id);
          return module.activate(context);
        },
      };
    };
  }

  it("activates a package with no declared events at startup", async () => {
    const order: string[] = [];
    const { runtime, host } = createHarness(
      [inventoryItem("example.legacy")],
      importerFor({ "example.legacy": { activate: () => undefined } }, order),
    );

    const summary = await runtime.start();
    expect(order).toEqual(["example.legacy"]);
    expect(summary.results).toEqual([
      expect.objectContaining({ extensionId: "example.legacy", status: "active" }),
    ]);
    expect(host.getState("example.legacy")?.status).toBe("active");
  });

  it("defers onProjectOpen until a project actually opens", async () => {
    const order: string[] = [];
    let fire: (() => void) | undefined;
    const { runtime, host } = createHarness(
      [
        inventoryItem("example.eager"),
        inventoryItem("example.deferred", {
          activationEvents: ["onProjectOpen"],
        }),
      ],
      importerFor(
        {
          "example.eager": { activate: () => undefined },
          "example.deferred": { activate: () => undefined },
        },
        order,
      ),
      {
        isProjectOpen: () => false,
        subscribeProjectOpen: (listener) => {
          fire = listener;
          return () => undefined;
        },
      },
    );

    const summary = await runtime.start();
    expect(order).toEqual(["example.eager"]);
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        extensionId: "example.deferred",
        status: "deferred",
        message: expect.stringContaining("onProjectOpen"),
      }),
    );
    expect(host.getState("example.deferred")).toBeUndefined();

    fire?.();
    await vi.waitFor(() => {
      expect(host.getState("example.deferred")?.status).toBe("active");
    });
    expect(order).toEqual(["example.eager", "example.deferred"]);
  });

  it("activates onProjectOpen immediately when a project is already open", async () => {
    const order: string[] = [];
    const { runtime } = createHarness(
      [inventoryItem("example.deferred", { activationEvents: ["onProjectOpen"] })],
      importerFor({ "example.deferred": { activate: () => undefined } }, order),
      { isProjectOpen: () => true },
    );

    const summary = await runtime.start();
    expect(order).toEqual(["example.deferred"]);
    expect(summary.results).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  it("pulls a deferred dependency forward and activates it first", async () => {
    const order: string[] = [];
    const seenPeerApi: unknown[] = [];
    const { runtime, peers } = createHarness(
      [
        // Inventory order puts the dependent first on purpose: the dependency
        // edge, not the listing, decides who runs first.
        inventoryItem("example.consumer", {
          dependencies: { "example.provider": ">=1.2.0 <2.0.0" },
        }),
        inventoryItem("example.provider", {
          version: "1.2.0",
          activationEvents: ["onProjectOpen"],
        }),
      ],
      importerFor(
        {
          "example.provider": {
            activate: (context: never) =>
              (context as { exportApi(api: object): void }).exportApi({
                zones: 5,
              }),
          },
          "example.consumer": {
            activate: (context: never) => {
              seenPeerApi.push(
                (
                  context as {
                    api: { peers: { requireApi(id: string): unknown } };
                  }
                ).api.peers.requireApi("example.provider"),
              );
            },
          },
        },
        order,
      ),
    );

    const summary = await runtime.start();
    expect(order).toEqual(["example.provider", "example.consumer"]);
    // The API is already published when the dependent runs, so `requireApi`
    // cannot race.
    expect(seenPeerApi).toEqual([{ zones: 5 }]);
    expect(peers.getApi("example.provider")).toEqual({ zones: 5 });
    expect(summary.results.map((result) => result.status)).toEqual([
      "active",
      "active",
    ]);
  });

  it("refuses a dependent whose dependency is missing or mismatched", async () => {
    const { runtime, host } = createHarness(
      [
        inventoryItem("example.missing-dep", {
          dependencies: { "example.absent": ">=1.0.0" },
        }),
        inventoryItem("example.bad-version", {
          dependencies: { "example.provider": ">=2.0.0" },
        }),
        inventoryItem("example.provider", { version: "1.2.0" }),
      ],
      importerFor({
        "example.missing-dep": { activate: () => undefined },
        "example.bad-version": { activate: () => undefined },
        "example.provider": { activate: () => undefined },
      }),
    );

    const summary = await runtime.start();
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        extensionId: "example.missing-dep",
        status: "failed",
        stage: "dependencies",
        message: expect.stringContaining("not installed"),
      }),
    );
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        extensionId: "example.bad-version",
        status: "failed",
        stage: "dependencies",
        message: expect.stringContaining(">=2.0.0"),
      }),
    );
    expect(host.getState("example.missing-dep")).toBeUndefined();
    expect(host.getState("example.provider")?.status).toBe("active");
  });

  it("fails a dependent when its dependency fails to activate", async () => {
    const { runtime, host, peers } = createHarness(
      [
        inventoryItem("example.consumer", {
          dependencies: { "example.provider": ">=1.0.0" },
        }),
        inventoryItem("example.provider"),
      ],
      importerFor({
        "example.provider": {
          activate: () => {
            throw new Error("provider exploded");
          },
        },
        "example.consumer": { activate: () => undefined },
      }),
    );

    const summary = await runtime.start();
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        extensionId: "example.consumer",
        status: "failed",
        stage: "dependencies",
        message: expect.stringContaining("did not activate"),
      }),
    );
    expect(host.getState("example.consumer")).toBeUndefined();
    expect(peers.isActive("example.provider")).toBe(false);
  });

  it("refuses a dependency cycle instead of recursing", async () => {
    const order: string[] = [];
    const observed: FrontendExtensionStartResult[] = [];
    const importModule = vi.fn(
      importerFor(
        {
          "example.a": { activate: () => undefined },
          "example.b": { activate: () => undefined },
        },
        order,
      ),
    );
    const { runtime, host } = createHarness(
      [
        inventoryItem("example.a", { dependencies: { "example.b": ">=1.0.0" } }),
        inventoryItem("example.b", { dependencies: { "example.a": ">=1.0.0" } }),
      ],
      importModule,
      {
        onResult: (result) => {
          observed.push(result);
        },
      },
    );

    const summary = await runtime.start();

    // Neither package is imported, let alone activated: the cycle is refused
    // before anything is fetched.
    expect(importModule).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(host.getState("example.a")).toBeUndefined();
    expect(host.getState("example.b")).toBeUndefined();

    // Exactly one result per package, each reported to the observer once. The
    // frame that detected the cycle owns the diagnostic; the outer frame's
    // derived "did not activate" message must not overwrite it.
    expect(observed).toHaveLength(2);
    expect(observed.map((result) => result.extensionId)).toEqual([
      "example.a",
      "example.b",
    ]);
    // The summary lists packages in inventory order and observers see them in
    // settle order, so compare by ID rather than position.
    expect(byId(summary.results)).toEqual(byId(observed));

    const [resultA, resultB] = observed;
    expect(resultA).toMatchObject({
      extensionId: "example.a",
      status: "failed",
      stage: "dependencies",
      message: "Dependency cycle: example.a -> example.b -> example.a. " +
        "Extensions cannot depend on each other in a loop.",
    });
    expect(resultB).toMatchObject({
      extensionId: "example.b",
      status: "failed",
      stage: "dependencies",
      // The dependent still says which package it was waiting on, and carries
      // the cycle through so the log is readable from either entry.
      message: expect.stringContaining("Dependency cycle"),
    });
    expect(resultB.message).toContain("example.a");
  });

  it("keeps the direct cycle diagnostic when a package sits on its own loop", async () => {
    const observed: FrontendExtensionStartResult[] = [];
    // A -> B -> C -> B: the loop does not include the package that started it,
    // so B is settled by the frame that closed the loop while A fails behind it.
    const { runtime } = createHarness(
      [
        inventoryItem("example.a", { dependencies: { "example.b": ">=1.0.0" } }),
        inventoryItem("example.b", { dependencies: { "example.c": ">=1.0.0" } }),
        inventoryItem("example.c", { dependencies: { "example.b": ">=1.0.0" } }),
      ],
      importerFor({
        "example.a": { activate: () => undefined },
        "example.b": { activate: () => undefined },
        "example.c": { activate: () => undefined },
      }),
      {
        onResult: (result) => {
          observed.push(result);
        },
      },
    );

    const summary = await runtime.start();

    expect(observed).toHaveLength(3);
    expect(new Set(observed.map((result) => result.extensionId))).toEqual(
      new Set(["example.a", "example.b", "example.c"]),
    );
    expect(byId(summary.results)).toEqual(byId(observed));
    expect(observed.every((result) => result.status === "failed")).toBe(true);
    expect(
      observed.find((result) => result.extensionId === "example.b")?.message,
    ).toContain("example.a -> example.b -> example.c -> example.b");
  });

  it("activates an onExtension listener after the package it names", async () => {
    const order: string[] = [];
    const { runtime, host } = createHarness(
      [
        inventoryItem("example.companion", {
          activationEvents: ["onExtension:example.host-package"],
        }),
        inventoryItem("example.host-package"),
      ],
      importerFor(
        {
          "example.companion": { activate: () => undefined },
          "example.host-package": { activate: () => undefined },
        },
        order,
      ),
    );

    await runtime.start();
    expect(order).toEqual(["example.host-package", "example.companion"]);
    expect(host.getState("example.companion")?.status).toBe("active");
  });

  it("leaves an onExtension listener deferred when its trigger never activates", async () => {
    const { runtime, host } = createHarness(
      [
        inventoryItem("example.companion", {
          activationEvents: ["onExtension:example.never"],
        }),
      ],
      importerFor({ "example.companion": { activate: () => undefined } }),
    );

    const summary = await runtime.start();
    expect(summary.results).toEqual([
      expect.objectContaining({ status: "deferred" }),
    ]);
    expect(host.getState("example.companion")).toBeUndefined();
  });

  it("treats an unrecognised activation event as startup rather than a dead package", async () => {
    const order: string[] = [];
    const { runtime } = createHarness(
      [
        inventoryItem("example.future", {
          activationEvents: ["onSomethingThisHostRetired"],
        }),
      ],
      importerFor({ "example.future": { activate: () => undefined } }, order),
    );

    await runtime.start();
    expect(order).toEqual(["example.future"]);
  });
});
