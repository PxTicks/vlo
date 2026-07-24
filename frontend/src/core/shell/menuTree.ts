export const MENU_TREE_VERSION = 1 as const;

export type MenuTreeNodeKind = "category" | "folder";

export interface MenuTreeNode {
  readonly id: string;
  readonly kind: MenuTreeNodeKind;
  readonly label: string;
  readonly parentId: string | null;
  readonly order: number;
}

export interface MenuTreeLeafPlacement {
  readonly leafId: string;
  readonly parentId: string | null;
  readonly order: number;
}

export interface MenuTreeDefinition {
  readonly version: typeof MENU_TREE_VERSION;
  readonly id: string;
  readonly nodes: readonly MenuTreeNode[];
  readonly leafPlacements: readonly MenuTreeLeafPlacement[];
}

export interface MenuTreeNodeOverride {
  readonly id: string;
  readonly label?: string;
  readonly parentId?: string | null;
  readonly order?: number;
  readonly deleted?: boolean;
}

export interface MenuTreeCustomization {
  readonly version: typeof MENU_TREE_VERSION;
  readonly customNodes: readonly MenuTreeNode[];
  readonly nodeOverrides: readonly MenuTreeNodeOverride[];
  /**
   * Only leaves whose placement differs from the registered default need to
   * be present. Unknown leaves may also be placed here before a later default
   * definition starts referencing them.
   */
  readonly leafPlacements: readonly MenuTreeLeafPlacement[];
}

export interface MenuTreeLayout {
  readonly nodes: readonly MenuTreeNode[];
  readonly leafPlacements: readonly MenuTreeLeafPlacement[];
}

export type MenuTreeItem =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "leaf"; readonly id: string };

const MENU_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function assertFiniteOrder(order: number, subject: string): void {
  if (!Number.isFinite(order)) {
    throw new Error(`${subject} order must be finite.`);
  }
}

function assertItemId(id: string, subject: string): void {
  if (!ITEM_ID_PATTERN.test(id)) {
    throw new Error(`${subject} has invalid ID '${id}'.`);
  }
}

function assertLabel(label: string, subject: string): void {
  if (label.trim().length === 0 || label.trim().length > 80) {
    throw new Error(`${subject} label must contain 1-80 characters.`);
  }
}

function assertNodeGraph(nodes: readonly MenuTreeNode[]): void {
  const byId = new Map<string, MenuTreeNode>();
  for (const node of nodes) {
    assertItemId(node.id, "Menu tree node");
    assertLabel(node.label, `Menu tree node '${node.id}'`);
    assertFiniteOrder(node.order, `Menu tree node '${node.id}'`);
    if (byId.has(node.id)) {
      throw new Error(`Duplicate menu tree node '${node.id}'.`);
    }
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (!parent) {
      throw new Error(
        `Menu tree node '${node.id}' references missing parent '${node.parentId}'.`,
      );
    }
    if (node.kind === "category" && parent.kind === "category") {
      throw new Error(
        `Menu tree category '${node.id}' cannot be nested beneath a category.`,
      );
    }
  }

  for (const node of nodes) {
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new Error(`Menu tree node '${node.id}' creates a cycle.`);
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

function assertLeafPlacements(
  placements: readonly MenuTreeLeafPlacement[],
  nodes: readonly MenuTreeNode[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const leafIds = new Set<string>();
  for (const placement of placements) {
    assertItemId(placement.leafId, "Menu tree leaf");
    assertFiniteOrder(
      placement.order,
      `Menu tree leaf '${placement.leafId}'`,
    );
    if (leafIds.has(placement.leafId)) {
      throw new Error(`Duplicate menu tree leaf '${placement.leafId}'.`);
    }
    if (placement.parentId !== null && !nodeIds.has(placement.parentId)) {
      throw new Error(
        `Menu tree leaf '${placement.leafId}' references missing parent '${placement.parentId}'.`,
      );
    }
    leafIds.add(placement.leafId);
  }
}

export function assertMenuTreeDefinition(
  definition: MenuTreeDefinition,
): void {
  if (definition.version !== MENU_TREE_VERSION) {
    throw new Error(`Unsupported menu tree version '${definition.version}'.`);
  }
  if (!MENU_ID_PATTERN.test(definition.id) || !definition.id.includes(".")) {
    throw new Error(`Invalid menu tree ID '${definition.id}'.`);
  }
  assertNodeGraph(definition.nodes);
  assertLeafPlacements(definition.leafPlacements, definition.nodes);
}

export function assertMenuTreeLayout(layout: MenuTreeLayout): void {
  assertNodeGraph(layout.nodes);
  assertLeafPlacements(layout.leafPlacements, layout.nodes);
}

export function assertMenuTreeCustomization(
  customization: MenuTreeCustomization,
): void {
  if (customization.version !== MENU_TREE_VERSION) {
    throw new Error(
      `Unsupported menu tree customization version '${customization.version}'.`,
    );
  }
  const customNodesById = new Map<string, MenuTreeNode>();
  for (const node of customization.customNodes) {
    assertItemId(node.id, "Custom menu tree node");
    assertLabel(node.label, `Custom menu tree node '${node.id}'`);
    assertFiniteOrder(node.order, `Custom menu tree node '${node.id}'`);
    if (customNodesById.has(node.id)) {
      throw new Error(`Duplicate custom menu tree node '${node.id}'.`);
    }
    customNodesById.set(node.id, node);
  }
  for (const node of customization.customNodes) {
    const customParent = node.parentId
      ? customNodesById.get(node.parentId)
      : undefined;
    if (
      node.kind === "category" &&
      customParent?.kind === "category"
    ) {
      throw new Error(
        `Custom menu tree category '${node.id}' cannot be nested beneath a category.`,
      );
    }
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId && customNodesById.has(parentId)) {
      if (visited.has(parentId)) {
        throw new Error(`Custom menu tree node '${node.id}' creates a cycle.`);
      }
      visited.add(parentId);
      parentId = customNodesById.get(parentId)?.parentId ?? null;
    }
  }

  const overrideIds = new Set<string>();
  for (const override of customization.nodeOverrides) {
    assertItemId(override.id, "Menu tree node override");
    if (overrideIds.has(override.id)) {
      throw new Error(`Duplicate menu tree node override '${override.id}'.`);
    }
    if (override.label !== undefined) {
      assertLabel(override.label, `Menu tree node override '${override.id}'`);
    }
    if (override.order !== undefined) {
      assertFiniteOrder(
        override.order,
        `Menu tree node override '${override.id}'`,
      );
    }
    overrideIds.add(override.id);
  }

  const leafIds = new Set<string>();
  for (const placement of customization.leafPlacements) {
    assertItemId(placement.leafId, "Menu tree customization leaf");
    assertFiniteOrder(
      placement.order,
      `Menu tree customization leaf '${placement.leafId}'`,
    );
    if (leafIds.has(placement.leafId)) {
      throw new Error(
        `Duplicate menu tree customization leaf '${placement.leafId}'.`,
      );
    }
    leafIds.add(placement.leafId);
  }
}

function compareOrdered(
  a: { readonly order: number; readonly id: string },
  b: { readonly order: number; readonly id: string },
): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

function sanitizeEffectiveLayout(layout: MenuTreeLayout): MenuTreeLayout {
  const remaining = new Map(layout.nodes.map((node) => [node.id, node]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of remaining.values()) {
      if (node.parentId !== null && !remaining.has(node.parentId)) {
        remaining.delete(node.id);
        changed = true;
      }
    }
  }

  const nodes = [...remaining.values()];
  try {
    assertNodeGraph(nodes);
  } catch {
    // Persisted data is not authoritative. Fall back to root placement for
    // invalid moves while retaining labels and order where possible.
    const normalized = nodes.map((node) => {
      const parent = node.parentId ? remaining.get(node.parentId) : undefined;
      return {
        ...node,
        parentId:
          parent && !(node.kind === "category" && parent.kind === "category")
            ? node.parentId
            : null,
      };
    });
    assertNodeGraph(normalized);
    return {
      nodes: normalized,
      leafPlacements: layout.leafPlacements.map((placement) => ({
        ...placement,
        parentId:
          placement.parentId && remaining.has(placement.parentId)
            ? placement.parentId
            : null,
      })),
    };
  }

  return {
    nodes,
    leafPlacements: layout.leafPlacements.map((placement) => ({
      ...placement,
      parentId:
        placement.parentId && remaining.has(placement.parentId)
          ? placement.parentId
          : null,
    })),
  };
}

export function resolveMenuTreeLayout(
  definition: MenuTreeDefinition,
  customization: MenuTreeCustomization | null,
  availableLeafIds: readonly string[],
): MenuTreeLayout {
  assertMenuTreeDefinition(definition);
  if (customization) assertMenuTreeCustomization(customization);

  const defaultNodes = new Map(
    definition.nodes.map((node) => [node.id, { ...node }]),
  );
  const effectiveNodes = new Map(defaultNodes);

  for (const override of customization?.nodeOverrides ?? []) {
    const node = effectiveNodes.get(override.id);
    if (!node) continue;
    if (override.deleted) {
      effectiveNodes.delete(override.id);
      continue;
    }
    effectiveNodes.set(override.id, {
      ...node,
      ...(override.label !== undefined
        ? { label: override.label.trim() }
        : {}),
      ...(override.parentId !== undefined
        ? { parentId: override.parentId }
        : {}),
      ...(override.order !== undefined ? { order: override.order } : {}),
    });
  }

  for (const node of customization?.customNodes ?? []) {
    if (!effectiveNodes.has(node.id) && !defaultNodes.has(node.id)) {
      effectiveNodes.set(node.id, { ...node, label: node.label.trim() });
    }
  }

  const available = new Set(availableLeafIds);
  const placements = new Map<string, MenuTreeLeafPlacement>();
  for (const placement of definition.leafPlacements) {
    if (available.has(placement.leafId)) {
      placements.set(placement.leafId, { ...placement });
    }
  }
  for (const placement of customization?.leafPlacements ?? []) {
    if (available.has(placement.leafId)) {
      placements.set(placement.leafId, { ...placement });
    }
  }

  const rootOrders = [
    ...[...effectiveNodes.values()]
      .filter((node) => node.parentId === null)
      .map((node) => node.order),
    ...[...placements.values()]
      .filter((leaf) => leaf.parentId === null)
      .map((leaf) => leaf.order),
  ];
  let nextRootOrder = Math.max(-1, ...rootOrders) + 1;
  for (const leafId of availableLeafIds) {
    if (!placements.has(leafId)) {
      placements.set(leafId, {
        leafId,
        parentId: null,
        order: nextRootOrder++,
      });
    }
  }

  const sanitized = sanitizeEffectiveLayout({
    nodes: [...effectiveNodes.values()],
    leafPlacements: [...placements.values()],
  });
  return {
    nodes: [...sanitized.nodes].sort(compareOrdered),
    leafPlacements: [...sanitized.leafPlacements].sort((a, b) =>
      compareOrdered(
        { id: a.leafId, order: a.order },
        { id: b.leafId, order: b.order },
      ),
    ),
  };
}

function placementEquals(
  a: MenuTreeLeafPlacement | undefined,
  b: MenuTreeLeafPlacement,
): boolean {
  return Boolean(
    a && a.parentId === b.parentId && Object.is(a.order, b.order),
  );
}

export function createMenuTreeCustomization(
  definition: MenuTreeDefinition,
  layout: MenuTreeLayout,
): MenuTreeCustomization {
  assertMenuTreeDefinition(definition);
  assertMenuTreeLayout(layout);

  const defaultNodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const layoutNodes = new Map(layout.nodes.map((node) => [node.id, node]));
  const customNodes = layout.nodes.filter((node) => !defaultNodes.has(node.id));
  const nodeOverrides: MenuTreeNodeOverride[] = [];

  for (const defaultNode of definition.nodes) {
    const node = layoutNodes.get(defaultNode.id);
    if (!node) {
      nodeOverrides.push({ id: defaultNode.id, deleted: true });
      continue;
    }
    const override: MenuTreeNodeOverride = { id: node.id };
    if (node.label !== defaultNode.label) {
      Object.assign(override, { label: node.label });
    }
    if (node.parentId !== defaultNode.parentId) {
      Object.assign(override, { parentId: node.parentId });
    }
    if (!Object.is(node.order, defaultNode.order)) {
      Object.assign(override, { order: node.order });
    }
    if (Object.keys(override).length > 1) nodeOverrides.push(override);
  }

  const defaults = new Map(
    definition.leafPlacements.map((leaf) => [leaf.leafId, leaf]),
  );
  const leafPlacements = layout.leafPlacements.filter(
    (leaf) => !placementEquals(defaults.get(leaf.leafId), leaf),
  );

  return {
    version: MENU_TREE_VERSION,
    customNodes,
    nodeOverrides,
    leafPlacements,
  };
}

function childrenAt(
  layout: MenuTreeLayout,
  parentId: string | null,
  excluded?: MenuTreeItem,
): MenuTreeItem[] {
  return [
    ...layout.nodes
      .filter(
        (node) =>
          node.parentId === parentId &&
          !(excluded?.kind === "node" && excluded.id === node.id),
      )
      .map((node) => ({
        item: { kind: "node", id: node.id } as const,
        order: node.order,
      })),
    ...layout.leafPlacements
      .filter(
        (leaf) =>
          leaf.parentId === parentId &&
          !(excluded?.kind === "leaf" && excluded.id === leaf.leafId),
      )
      .map((leaf) => ({
        item: { kind: "leaf", id: leaf.leafId } as const,
        order: leaf.order,
      })),
  ]
    .sort((a, b) =>
      compareOrdered(
        { id: a.item.id, order: a.order },
        { id: b.item.id, order: b.order },
      ),
    )
    .map(({ item }) => item);
}

function withReindexedChildren(
  layout: MenuTreeLayout,
  parentId: string | null,
  ordered: readonly MenuTreeItem[],
): MenuTreeLayout {
  const orders = new Map(
    ordered.map((item, index) => [`${item.kind}:${item.id}`, index]),
  );
  return {
    nodes: layout.nodes.map((node) =>
      node.parentId === parentId
        ? { ...node, order: orders.get(`node:${node.id}`) ?? node.order }
        : node,
    ),
    leafPlacements: layout.leafPlacements.map((leaf) =>
      leaf.parentId === parentId
        ? {
            ...leaf,
            order: orders.get(`leaf:${leaf.leafId}`) ?? leaf.order,
          }
        : leaf,
    ),
  };
}

function getItemParent(
  layout: MenuTreeLayout,
  item: MenuTreeItem,
): string | null {
  if (item.kind === "node") {
    const node = layout.nodes.find((candidate) => candidate.id === item.id);
    if (!node) throw new Error(`Unknown menu tree node '${item.id}'.`);
    return node.parentId;
  }
  const leaf = layout.leafPlacements.find(
    (candidate) => candidate.leafId === item.id,
  );
  if (!leaf) throw new Error(`Unknown menu tree leaf '${item.id}'.`);
  return leaf.parentId;
}

export function addMenuTreeNode(
  layout: MenuTreeLayout,
  node: Omit<MenuTreeNode, "order"> & { readonly order?: number },
): MenuTreeLayout {
  assertItemId(node.id, "Menu tree node");
  if (layout.nodes.some((candidate) => candidate.id === node.id)) {
    throw new Error(`Menu tree node '${node.id}' already exists.`);
  }
  const siblings = childrenAt(layout, node.parentId);
  const next = {
    nodes: [
      ...layout.nodes,
      { ...node, label: node.label.trim(), order: node.order ?? siblings.length },
    ],
    leafPlacements: layout.leafPlacements,
  };
  assertMenuTreeLayout(next);
  return next;
}

export function renameMenuTreeNode(
  layout: MenuTreeLayout,
  nodeId: string,
  label: string,
): MenuTreeLayout {
  assertLabel(label, `Menu tree node '${nodeId}'`);
  if (!layout.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Unknown menu tree node '${nodeId}'.`);
  }
  return {
    ...layout,
    nodes: layout.nodes.map((node) =>
      node.id === nodeId ? { ...node, label: label.trim() } : node,
    ),
  };
}

export function moveMenuTreeItem(
  layout: MenuTreeLayout,
  item: MenuTreeItem,
  parentId: string | null,
  index: number,
): MenuTreeLayout {
  const oldParentId = getItemParent(layout, item);
  const parent = parentId
    ? layout.nodes.find((node) => node.id === parentId)
    : null;
  if (parentId !== null && !parent) {
    throw new Error(`Unknown menu tree parent '${parentId}'.`);
  }

  if (item.kind === "node") {
    const node = layout.nodes.find((candidate) => candidate.id === item.id);
    if (!node) throw new Error(`Unknown menu tree node '${item.id}'.`);
    if (node.kind === "category" && parent?.kind === "category") {
      throw new Error("A category cannot be moved beneath another category.");
    }
    let ancestorId = parentId;
    while (ancestorId !== null) {
      if (ancestorId === item.id) {
        throw new Error("A menu tree node cannot be moved into itself.");
      }
      ancestorId =
        layout.nodes.find((candidate) => candidate.id === ancestorId)
          ?.parentId ?? null;
    }
  }

  let next: MenuTreeLayout =
    item.kind === "node"
      ? {
          ...layout,
          nodes: layout.nodes.map((node) =>
            node.id === item.id ? { ...node, parentId } : node,
          ),
        }
      : {
          ...layout,
          leafPlacements: layout.leafPlacements.map((leaf) =>
            leaf.leafId === item.id ? { ...leaf, parentId } : leaf,
          ),
        };

  if (oldParentId !== parentId) {
    next = withReindexedChildren(
      next,
      oldParentId,
      childrenAt(next, oldParentId),
    );
  }
  const target = childrenAt(next, parentId, item);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, item);
  next = withReindexedChildren(next, parentId, target);
  assertMenuTreeLayout(next);
  return next;
}

export function deleteMenuTreeNode(
  layout: MenuTreeLayout,
  nodeId: string,
): MenuTreeLayout {
  if (!layout.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Unknown menu tree node '${nodeId}'.`);
  }
  const hasChildren =
    layout.nodes.some((node) => node.parentId === nodeId) ||
    layout.leafPlacements.some((leaf) => leaf.parentId === nodeId);
  if (hasChildren) {
    throw new Error(`Menu tree node '${nodeId}' must be empty before deletion.`);
  }
  return {
    nodes: layout.nodes.filter((node) => node.id !== nodeId),
    leafPlacements: layout.leafPlacements,
  };
}

export function getMenuTreeChildren(
  layout: MenuTreeLayout,
  parentId: string | null,
): readonly MenuTreeItem[] {
  return childrenAt(layout, parentId);
}
