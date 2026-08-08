/**
 * Adapter from the shell's view table to the layout kernel's panel descriptors.
 *
 * The resolver must stay pure, so this is where the live registry is read and
 * declarative availability is collapsed into a boolean. Host views and
 * extension views go through the same path: the kernel never learns which is
 * which beyond the `source` hint it needs for default selection.
 */
import {
  hostViewRegistry,
  type HostViewRegistry,
} from "../viewRegistry";
import { DOCK_REGIONS, type ShellPanelDescriptor } from "./layoutTypes";

export function describeShellPanels(
  registry: HostViewRegistry = hostViewRegistry,
): readonly ShellPanelDescriptor[] {
  const descriptors: ShellPanelDescriptor[] = [];
  for (const region of DOCK_REGIONS) {
    // The registry applies its own hidden/order preferences when listing.
    // Descriptors report the registration's `order` and re-sort by it, so the
    // panel table stays a pure function of what is registered and the user's
    // ordering is applied exactly once — by the resolver.
    const placed = [
      ...registry.list(region, {
        includeHidden: true,
        includeUnavailable: true,
      }),
    ].sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
    const available = new Set(
      registry.list(region, { includeHidden: true }).map((entry) => entry.id),
    );
    for (const entry of placed) {
      descriptors.push({
        id: entry.id,
        defaultRegion: region,
        // Phase C teaches registration about portability. Until then every
        // panel is fixed to the region it registered into.
        allowedRegions: [region],
        defaultOrder: entry.order,
        available: available.has(entry.id),
        source: entry.source,
      });
    }
  }
  return descriptors;
}

export function arePanelDescriptorsEqual(
  left: readonly ShellPanelDescriptor[],
  right: readonly ShellPanelDescriptor[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    return (
      descriptor.id === other.id &&
      descriptor.defaultRegion === other.defaultRegion &&
      descriptor.defaultOrder === other.defaultOrder &&
      descriptor.available === other.available &&
      descriptor.source === other.source &&
      descriptor.preferredSizePx === other.preferredSizePx &&
      descriptor.minimumSizePx === other.minimumSizePx &&
      descriptor.maximumSizePx === other.maximumSizePx &&
      descriptor.allowedRegions.length === other.allowedRegions.length &&
      descriptor.allowedRegions.every(
        (region, regionIndex) => region === other.allowedRegions[regionIndex],
      )
    );
  });
}
