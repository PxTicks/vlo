import type { Container } from "pixi.js";

const previewOnlyTargets = new WeakSet<Container>();

/**
 * Marks a Pixi node as editor-only presentation that must not reach output
 * samples. Mark every preview-only root, including nodes already kept outside
 * the content target: structural separation is the primary boundary and this
 * marker preserves it if a node is later reparented.
 */
export function markPixiPreviewOnly(target: Container): void {
  previewOnlyTargets.add(target);
}

/**
 * Runs a synchronous readback with nested preview-only nodes disabled.
 *
 * Most editor overlays are siblings of the active content target. This guard
 * also covers previews that must live inside a renderer-owned subtree, such as
 * the blue asset-mask preview.
 */
export function withoutPixiPreviewOnlyNodes<T>(
  target: Container,
  read: () => T,
): T {
  const hidden: Array<{ target: Container; renderable: boolean }> = [];
  const visit = (node: Container): void => {
    if (previewOnlyTargets.has(node)) {
      hidden.push({ target: node, renderable: node.renderable });
      node.renderable = false;
      return;
    }
    for (const child of node.children) visit(child);
  };

  visit(target);
  try {
    return read();
  } finally {
    for (const entry of hidden) {
      if (!entry.target.destroyed) entry.target.renderable = entry.renderable;
    }
  }
}
