import type { ExtensionModule, VloExtensionApi } from "../types";
import { extensionLutRegistry } from "../registry/ExtensionLutRegistry";
import type { ExtensionInventoryItem } from "./extensionManagementApi";

export function composeManifestContributions(
  item: ExtensionInventoryItem,
  executableModule?: ExtensionModule<VloExtensionApi>,
): ExtensionModule<VloExtensionApi> | undefined {
  const lutContributions = item.lutContributions ?? [];
  if (lutContributions.length === 0) return executableModule;
  if (item.manifest === null || item.digest === null) return undefined;
  const manifest = item.manifest;
  const digest = item.digest;

  return {
    async activate(context) {
      for (const lut of lutContributions) {
        const registration = extensionLutRegistry.registerPackageLut(item.id, {
          id: lut.id,
          apiVersion: 1,
          label: lut.label,
          ...(lut.description ? { description: lut.description } : {}),
          order: lut.order,
          resourceUrl: lut.resourceUrl,
          packageVersion: manifest.version,
          packageDigest: digest,
        });
        context.onDispose(registration);
      }

      return executableModule?.activate(context);
    },
  };
}
