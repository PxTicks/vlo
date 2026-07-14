import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import type { ExtensionInventoryItem } from "../../services/extensionManagementApi";
import { composeManifestContributions } from "../../services/manifestContributions";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import type { VloExtensionApi } from "../../types";
import { ExtensionLutRegistry, extensionLutRegistry } from "../ExtensionLutRegistry";

function definition(id: string, order: number) {
  return {
    id,
    apiVersion: 1 as const,
    label: id.toUpperCase(),
    order,
    resourceUrl: `/resources/${id}.cube`,
    packageVersion: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
  };
}

describe("ExtensionLutRegistry", () => {
  it("owner-qualifies, orders, and disposes package LUTs", () => {
    const registry = new ExtensionLutRegistry();
    const second = registry.registerPackageLut(
      "example.looks",
      definition("second", 20),
    );
    const first = registry.registerPackageLut(
      "example.looks",
      definition("first", 10),
    );

    expect(registry.list().map((entry) => entry.id)).toEqual([
      "example.looks/first",
      "example.looks/second",
    ]);

    first.dispose();
    second.dispose();
    expect(registry.list()).toEqual([]);
  });

  it("enrolls manifest contributions in the normal activation lifecycle", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const item: ExtensionInventoryItem = {
      id: "example.manifest-looks",
      sourcePath: "/extensions/installed/example.manifest-looks",
      status: "approved",
      digest,
      errors: [],
      manifest: {
        manifestVersion: 1,
        id: "example.manifest-looks",
        name: "Manifest Looks",
        version: "1.0.0",
        sdk: ">=1.0.0 <2.0.0",
        contributions: { luts: "luts.json" },
        capabilities: ["color.luts"],
      },
      approval: {
        digest,
        version: "1.0.0",
        approvedAt: 1,
        enabled: true,
      },
      backendRuntime: {
        status: "not_declared",
        message: "No backend entry point is declared.",
        digest: null,
      },
      preflight: null,
      frontendEntryUrl: null,
      lutContributions: [
        {
          id: "warm",
          label: "Warm",
          description: null,
          order: 0,
          resourceUrl: "/resources/warm.cube",
        },
      ],
    };
    const module = composeManifestContributions(item);
    expect(module).toBeDefined();
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.5.0",
      createApi: createVloExtensionApi,
    });

    try {
      await host.activate(
        { id: item.id, version: item.manifest!.version },
        module!,
      );
      expect(
        extensionLutRegistry.list().some((entry) => entry.id === `${item.id}/warm`),
      ).toBe(true);
    } finally {
      await host.deactivate(item.id);
    }
    expect(
      extensionLutRegistry.list().some((entry) => entry.id === `${item.id}/warm`),
    ).toBe(false);
  });
});
