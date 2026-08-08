/**
 * Randomized invariant coverage for the resolver (plan §8.1). A tiny seeded
 * generator keeps this dependency-free and reproducible: a failure prints the
 * seed, and re-running that seed reproduces the exact case.
 */
import { describe, expect, it } from "vitest";
import { resolveShellLayout } from "../layoutResolver";
import {
  DOCK_REGIONS,
  DOCK_REGION_CONSTRAINTS,
  type DockRegion,
  type ResolvedShellLayout,
  type ShellLayoutDocumentV2,
  type ShellPanelDescriptor,
  type ShellViewport,
} from "../layoutTypes";

function createRandom(seed: number) {
  let state = (seed || 1) >>> 0;
  return () => {
    // xorshift32: deterministic, uniform enough, and no dependency.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface Sample {
  readonly panels: readonly ShellPanelDescriptor[];
  readonly document: ShellLayoutDocumentV2;
  readonly viewport: ShellViewport | null;
}

function generateSample(random: () => number): Sample {
  const pick = <T,>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  const panelCount = Math.floor(random() * 8);
  const panels: ShellPanelDescriptor[] = [];
  const panelRecord: Record<
    string,
    { region?: DockRegion; visible?: boolean; order?: number }
  > = {};

  for (let index = 0; index < panelCount; index += 1) {
    const source = random() < 0.5 ? "host" : "extension";
    const defaultRegion = pick(DOCK_REGIONS);
    const allowedRegions =
      random() < 0.4
        ? [defaultRegion, pick(DOCK_REGIONS)]
        : [defaultRegion];
    const id = `${source === "host" ? "host" : "example.a"}${
      source === "host" ? "." : "/"
    }p${index}`;
    panels.push({
      id,
      defaultRegion,
      allowedRegions,
      defaultOrder: Math.floor(random() * 50),
      available: random() < 0.75,
      source,
      // Deliberately overshoots every region's configured maximum (720px at
      // the widest) so contradictory and out-of-range panel bounds are part of
      // the sample rather than an edge case nobody generates.
      preferredSizePx: random() < 0.3 ? random() * 1200 : undefined,
      minimumSizePx: random() < 0.35 ? random() * 1200 : undefined,
      maximumSizePx: random() < 0.35 ? random() * 1200 : undefined,
    });
    if (random() < 0.6) {
      panelRecord[id] = {
        region: random() < 0.5 ? pick(DOCK_REGIONS) : undefined,
        visible: random() < 0.4 ? false : undefined,
        order: random() < 0.5 ? Math.floor(random() * 10) : undefined,
      };
    }
  }
  // Placement intent left behind by a panel that is no longer registered.
  if (random() < 0.5) panelRecord["example.gone/panel"] = { order: 0 };

  const regions: Partial<
    Record<
      DockRegion,
      { selectedViewId?: string | null; collapsed?: boolean; sizePx?: number }
    >
  > = {};
  for (const region of DOCK_REGIONS) {
    if (random() < 0.5) continue;
    regions[region] = {
      selectedViewId:
        random() < 0.3
          ? "example.gone/panel"
          : (panels[Math.floor(random() * Math.max(panels.length, 1))]?.id ??
            null),
      collapsed: random() < 0.3,
      sizePx: random() < 0.7 ? random() * 1500 : undefined,
    };
  }

  return {
    panels,
    document: { version: 2, panels: panelRecord, regions, workspaceLayouts: {} },
    viewport:
      random() < 0.5
        ? { widthPx: 200 + random() * 3000, heightPx: 200 + random() * 2000 }
        : null,
  };
}

function assertInvariants(
  resolved: ResolvedShellLayout,
  panels: readonly ShellPanelDescriptor[],
): void {
  const byId = new Map(panels.map((descriptor) => [descriptor.id, descriptor]));
  const seen = new Set<string>();

  for (const regionId of DOCK_REGIONS) {
    const region = resolved.regions[regionId];
    expect(region.id).toBe(regionId);

    for (const viewId of region.placedViewIds) {
      // Every placed panel is registered, placed exactly once, and allowed here.
      const descriptor = byId.get(viewId);
      expect(descriptor).toBeDefined();
      expect(seen.has(viewId)).toBe(false);
      seen.add(viewId);
      expect(resolved.panelRegions[viewId]).toBe(regionId);
      expect(
        regionId === descriptor?.defaultRegion ||
          descriptor?.allowedRegions.includes(regionId),
      ).toBe(true);
    }

    // The tab strip is an order-preserving subset of what is placed here.
    const placedIndex = new Map(
      region.placedViewIds.map((id, index) => [id, index] as const),
    );
    let previous = -1;
    for (const viewId of region.orderedViewIds) {
      const index = placedIndex.get(viewId);
      expect(index).toBeDefined();
      expect(index as number).toBeGreaterThan(previous);
      previous = index as number;
    }

    // A selection is always a real, selectable member of its own region.
    if (region.selectedViewId !== null) {
      expect(region.orderedViewIds).toContain(region.selectedViewId);
    } else if (DOCK_REGION_CONSTRAINTS[regionId].autoSelect) {
      expect(region.orderedViewIds).toHaveLength(0);
    }

    // Sizes are finite, ordered, and never exceed the remembered preference.
    expect(Number.isFinite(region.sizePx)).toBe(true);
    expect(Number.isFinite(region.userSizePx)).toBe(true);
    expect(region.minimumSizePx).toBeLessThanOrEqual(region.maximumSizePx);
    expect(region.userSizePx).toBeGreaterThanOrEqual(region.minimumSizePx);
    expect(region.userSizePx).toBeLessThanOrEqual(region.maximumSizePx);
    expect(region.sizePx).toBeGreaterThan(0);
    expect(region.sizePx).toBeLessThanOrEqual(region.userSizePx);

    // The region's configured band is authoritative. No descriptor hint —
    // however malformed — may widen it. The viewport-effective `sizePx` is the
    // one value allowed to fall below the minimum, because a window too narrow
    // for the band still has to render something.
    const configured = DOCK_REGION_CONSTRAINTS[regionId];
    expect(region.minimumSizePx).toBeGreaterThanOrEqual(
      Math.min(configured.minimumSizePx, configured.maximumSizePx),
    );
    expect(region.minimumSizePx).toBeLessThanOrEqual(configured.maximumSizePx);
    expect(region.maximumSizePx).toBeLessThanOrEqual(configured.maximumSizePx);
    expect(region.userSizePx).toBeLessThanOrEqual(configured.maximumSizePx);
    expect(region.sizePx).toBeLessThanOrEqual(configured.maximumSizePx);
  }

  expect(seen.size).toBe(byId.size);
  expect(Object.keys(resolved.panelRegions).sort()).toEqual(
    [...byId.keys()].sort(),
  );
}

describe("resolver invariants", () => {
  it("holds for randomized registries, documents, and viewports", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = createRandom(seed);
      const sample = generateSample(random);
      try {
        assertInvariants(
          resolveShellLayout({
            panels: sample.panels,
            document: sample.document,
            viewport: sample.viewport,
          }),
          sample.panels,
        );
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });

  it("stays valid when any single owner is removed", () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const sample = generateSample(createRandom(seed));
      for (const removed of sample.panels) {
        const remaining = sample.panels.filter(
          (descriptor) => descriptor.id !== removed.id,
        );
        try {
          assertInvariants(
            resolveShellLayout({
              panels: remaining,
              document: sample.document,
              viewport: sample.viewport,
            }),
            remaining,
          );
        } catch (error) {
          throw new Error(
            `seed ${seed} without ${removed.id}: ${(error as Error).message}`,
          );
        }
      }
    }
  });

  it("is a pure function of its inputs", () => {
    const sample = generateSample(createRandom(7));
    const first = resolveShellLayout({
      panels: sample.panels,
      document: sample.document,
      viewport: sample.viewport,
    });
    const second = resolveShellLayout({
      panels: sample.panels,
      document: sample.document,
      viewport: sample.viewport,
    });

    expect(second).toEqual(first);
  });
});
