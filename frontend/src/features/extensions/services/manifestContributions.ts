import { VLO_APP_VERSION } from "../../project/constants";
import { VLO_EXTENSION_SDK_VERSION } from "../constants";
import {
  extensionLutRegistry,
  type ExtensionLutPackageProjection,
  type ExtensionLutRegistry,
} from "../registry/ExtensionLutRegistry";
import {
  evaluateExtensionSdkCompatibility,
  evaluateExtensionVloCompatibility,
} from "../utils/sdkCompatibility";
import type { ExtensionInventoryItem } from "./extensionManagementApi";

export interface ManifestContributionProjectionDiagnostic {
  readonly extensionId: string;
  readonly level: "warning" | "error";
  readonly message: string;
  readonly error?: unknown;
}

export interface ManifestContributionProjectionOptions {
  readonly registry?: ExtensionLutRegistry;
  readonly sdkVersion?: string;
  readonly hostVersion?: string | null;
}

function isApprovedExactDigest(item: ExtensionInventoryItem): boolean {
  return (
    item.status === "approved" &&
    item.manifest !== null &&
    item.manifest.id === item.id &&
    item.digest !== null &&
    item.approval !== null &&
    item.approval.enabled &&
    item.approval.digest === item.digest
  );
}

/**
 * Projects approved declarative package data directly into domain registries.
 * This is deliberately independent of executable module activation: a broken
 * frontend entry cannot suppress otherwise valid, immutable LUT resources.
 */
export function projectManifestContributions(
  inventory: readonly ExtensionInventoryItem[],
  options: ManifestContributionProjectionOptions = {},
): readonly ManifestContributionProjectionDiagnostic[] {
  const registry = options.registry ?? extensionLutRegistry;
  const sdkVersion = options.sdkVersion ?? VLO_EXTENSION_SDK_VERSION;
  const hostVersion =
    options.hostVersion === undefined ? VLO_APP_VERSION : options.hostVersion;
  const projections: ExtensionLutPackageProjection[] = [];
  const diagnostics: ManifestContributionProjectionDiagnostic[] = [];

  for (const item of inventory) {
    if (!isApprovedExactDigest(item)) continue;
    const manifest = item.manifest;
    const digest = item.digest;
    if (manifest === null || digest === null) continue;

    const luts = item.lutContributions ?? [];
    if (luts.length === 0) continue;

    const sdkCompatibility = evaluateExtensionSdkCompatibility(
      manifest.sdk,
      sdkVersion,
    );
    if (!sdkCompatibility.compatible) {
      diagnostics.push({
        extensionId: item.id,
        level: "error",
        message:
          sdkCompatibility.reason ??
          "The declarative package SDK range is incompatible.",
      });
      continue;
    }

    if (manifest.vlo !== undefined) {
      const vloCompatibility = evaluateExtensionVloCompatibility(
        manifest.vlo,
        hostVersion,
      );
      if (!vloCompatibility.compatible) {
        diagnostics.push({
          extensionId: item.id,
          level: "error",
          message:
            vloCompatibility.reason ??
            "The declarative package VLO range is incompatible.",
        });
        continue;
      }
      if (vloCompatibility.warning) {
        diagnostics.push({
          extensionId: item.id,
          level: "warning",
          message: vloCompatibility.warning,
        });
      }
    }

    projections.push({
      ownerId: item.id,
      packageVersion: manifest.version,
      packageDigest: digest,
      luts: luts.map((lut) => ({
        id: lut.id,
        label: lut.label,
        ...(lut.description ? { description: lut.description } : {}),
        order: lut.order,
        resourceUrl: lut.resourceUrl,
      })),
    });
  }

  for (const failure of registry.reconcilePackages(projections)) {
    diagnostics.push({
      extensionId: failure.ownerId,
      level: "error",
      message: `Could not project LUT contributions for '${failure.ownerId}'.`,
      error: failure.error,
    });
  }

  return Object.freeze(diagnostics);
}
