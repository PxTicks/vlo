/**
 * Adapter from the shell's view table to the layout kernel's panel descriptors.
 *
 * The resolver must stay pure, so this is where the live registry is read and
 * declarative availability is collapsed into a boolean. Host views and
 * extension views go through the same path: the kernel never learns which is
 * which beyond the `source` hint it needs for default selection.
 */
import { hostContextKeys, type HostContextKeyService } from "../contextKeys";
import {
  editorSurfaceRegistry,
  type EditorSurfaceRegistry,
} from "../editorSurfaces";
import {
  hostViewRegistry,
  type HostViewRegistry,
} from "../viewRegistry";
import {
  DOCK_REGIONS,
  type ShellPanelDescriptor,
  type ShellSurfaceDescriptor,
} from "./layoutTypes";

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
        // Validated at registration, so the resolver can trust it: a panel is
        // fixed to its registration region unless it opted into more.
        allowedRegions: entry.allowedRegions,
        defaultOrder: entry.order,
        available: available.has(entry.id),
        defaultVisible: entry.defaultVisible,
        source: entry.source,
      });
    }
  }
  return descriptors;
}

/**
 * Keeps a panel table in step with the live shell without React in the loop.
 *
 * Placement is now resolved state, so a non-React caller — an extension
 * activating, a feature revealing its panel, a component rendered outside the
 * editor shell in a test — must see the same table the editor does. Pushing
 * descriptors from a component effect would make that depend on what happens to
 * be mounted.
 */
export function observeShellPanels(
  onChange: (panels: readonly ShellPanelDescriptor[]) => void,
  registry: HostViewRegistry = hostViewRegistry,
  contextKeys: HostContextKeyService = hostContextKeys,
): () => void {
  const publish = (): void => {
    onChange(describeShellPanels(registry));
  };
  const unsubscribeViews = registry.subscribe(publish);
  const unsubscribeContext = contextKeys.subscribe(publish);
  publish();
  return () => {
    unsubscribeViews();
    unsubscribeContext();
  };
}

export function describeEditorSurfaces(
  registry: EditorSurfaceRegistry = editorSurfaceRegistry,
): readonly ShellSurfaceDescriptor[] {
  return registry
    .list()
    .map((entry) => ({
      id: entry.id,
      defaultStage: entry.defaultStage,
      // Validated at registration, so the resolver can trust it.
      allowedStages: entry.allowedStages,
      defaultOrder: entry.order,
      available: registry.isAvailable(entry.id),
    }))
    .sort(
      (left, right) =>
        left.defaultOrder - right.defaultOrder ||
        left.id.localeCompare(right.id),
    );
}

/** Surface counterpart to {@link observeShellPanels}; same reasons apply. */
export function observeEditorSurfaces(
  onChange: (surfaces: readonly ShellSurfaceDescriptor[]) => void,
  registry: EditorSurfaceRegistry = editorSurfaceRegistry,
  contextKeys: HostContextKeyService = hostContextKeys,
): () => void {
  const publish = (): void => {
    onChange(describeEditorSurfaces(registry));
  };
  const unsubscribeSurfaces = registry.subscribe(publish);
  const unsubscribeContext = contextKeys.subscribe(publish);
  publish();
  return () => {
    unsubscribeSurfaces();
    unsubscribeContext();
  };
}

export function areSurfaceDescriptorsEqual(
  left: readonly ShellSurfaceDescriptor[],
  right: readonly ShellSurfaceDescriptor[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    return (
      descriptor.id === other.id &&
      descriptor.defaultStage === other.defaultStage &&
      descriptor.defaultOrder === other.defaultOrder &&
      descriptor.available === other.available &&
      descriptor.allowedStages.length === other.allowedStages.length &&
      descriptor.allowedStages.every(
        (stage, stageIndex) => stage === other.allowedStages[stageIndex],
      )
    );
  });
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
      descriptor.defaultVisible === other.defaultVisible &&
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
