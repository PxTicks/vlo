import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { ExtensionLutRegistry } from "../../registry/ExtensionLutRegistry";
import { FrontendExtensionRuntime } from "../FrontendExtensionRuntime";
import type { ExtensionInventoryItem } from "../extensionManagementApi";
import { projectManifestContributions } from "../manifestContributions";

function inventoryItem(
  id: string,
  options: {
    digest?: string;
    sdk?: string;
    vlo?: string;
    frontend?: boolean;
    status?: ExtensionInventoryItem["status"];
  } = {},
): ExtensionInventoryItem {
  const digest =
    options.digest ?? `sha256:${id.charCodeAt(0).toString(16).repeat(64)}`;
  const status = options.status ?? "approved";
  return {
    id,
    sourcePath: `/extensions/installed/${id}`,
    status,
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      sdk: options.sdk ?? ">=1.5.0 <2.0.0",
      ...(options.vlo ? { vlo: options.vlo } : {}),
      ...(options.frontend
        ? { frontend: { entry: "frontend/dist/index.js" } }
        : {}),
      contributions: { luts: "luts.json" },
      capabilities: ["color.luts"],
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
      status: "not_declared",
      message: "No backend entry point is declared.",
      digest: null,
    },
    preflight: null,
    frontendEntryUrl: options.frontend
      ? `/app/extensions/${id}/frontend/${digest}/index.js`
      : null,
    lutContributions: [
      {
        id: "warm",
        label: "Warm",
        description: null,
        order: 0,
        resourceUrl: `/app/extensions/${id}/resources/${digest}/warm.cube`,
      },
    ],
  };
}

describe("projectManifestContributions", () => {
  it("projects approved LUTs without requiring executable activation", () => {
    const registry = new ExtensionLutRegistry();
    const item = inventoryItem("example.mixed", { frontend: true });

    const diagnostics = projectManifestContributions([item], {
      registry,
      sdkVersion: "1.5.0",
      hostVersion: "0.2.0",
    });

    expect(diagnostics).toEqual([]);
    expect(registry.list().map((entry) => entry.id)).toEqual([
      "example.mixed/warm",
    ]);
  });

  it("keeps mixed-package LUTs when executable activation fails", async () => {
    const registry = new ExtensionLutRegistry();
    const item = inventoryItem("example.broken-mixed", { frontend: true });
    const host = new ExtensionHost<Record<string, never>>({
      sdkVersion: "1.5.0",
      hostVersion: "0.2.0",
      createApi: () => ({}),
    });
    const runtime = new FrontendExtensionRuntime({
      host,
      loadInventory: async () => {
        projectManifestContributions([item], {
          registry,
          sdkVersion: "1.5.0",
          hostVersion: "0.2.0",
        });
        return [item];
      },
      importModule: async () => ({
        activate() {
          throw new Error("Broken executable entry");
        },
      }),
    });

    const summary = await runtime.start();

    expect(summary.results[0]).toMatchObject({
      extensionId: item.id,
      status: "failed",
      stage: "activation",
    });
    expect(registry.list().map((entry) => entry.id)).toEqual([
      "example.broken-mixed/warm",
    ]);
  });

  it("removes projections disabled in the next startup inventory", () => {
    const registry = new ExtensionLutRegistry();
    projectManifestContributions([inventoryItem("example.looks")], {
      registry,
      sdkVersion: "1.5.0",
      hostVersion: "0.2.0",
    });

    projectManifestContributions(
      [inventoryItem("example.looks", { status: "disabled" })],
      {
        registry,
        sdkVersion: "1.5.0",
        hostVersion: "0.2.0",
      },
    );

    expect(registry.list()).toEqual([]);
  });

  it("fails incompatible SDK and VLO ranges closed", () => {
    const registry = new ExtensionLutRegistry();
    const diagnostics = projectManifestContributions(
      [
        inventoryItem("example.future-sdk", { sdk: ">=2.0.0" }),
        inventoryItem("example.future-vlo", { vlo: ">=0.3.0" }),
      ],
      {
        registry,
        sdkVersion: "1.5.0",
        hostVersion: "0.2.0",
      },
    );

    expect(registry.list()).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.level === "error")).toBe(
      true,
    );
    expect(diagnostics.map((diagnostic) => diagnostic.extensionId)).toEqual([
      "example.future-sdk",
      "example.future-vlo",
    ]);
  });

  it("warns and projects when the VLO build version is unknown", () => {
    const registry = new ExtensionLutRegistry();
    const diagnostics = projectManifestContributions(
      [inventoryItem("example.unknown-vlo", { vlo: ">=0.2.0 <0.3.0" })],
      {
        registry,
        sdkVersion: "1.5.0",
        hostVersion: null,
      },
    );

    expect(registry.list()).toHaveLength(1);
    expect(diagnostics).toMatchObject([
      { extensionId: "example.unknown-vlo", level: "warning" },
    ]);
  });
});
