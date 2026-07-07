import { describe, expect, it } from "vitest";

const MAX_LARGEST_SCC_SIZE = 61;

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const VALUE_IMPORT_SOURCE =
  /(?:^|\n)\s*import\s+(?!type\b)(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;
const VALUE_EXPORT_SOURCE =
  /(?:^|\n)\s*export\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g;

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function moduleId(path: string): string {
  return path.replace(/\.(ts|tsx)$/, "");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function isProductionSource(path: string): boolean {
  return !path.includes("__tests__") && !path.includes(".test.");
}

function resolveImport(
  importerId: string,
  specifier: string,
  modules: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const parts = importerId.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const resolved = parts.join("/");
  if (modules.has(resolved)) return resolved;
  if (modules.has(`${resolved}/index`)) return `${resolved}/index`;
  return null;
}

function buildValueImportGraph(): Map<string, Set<string>> {
  const files = Object.entries(RAW_FILES)
    .map(([globKey, source]) => [normalize(globKey), source] as const)
    .filter(([path]) => isProductionSource(path));
  const modules = new Set(files.map(([path]) => moduleId(path)));
  const graph = new Map<string, Set<string>>(
    [...modules].map((id) => [id, new Set<string>()]),
  );

  for (const [path, source] of files) {
    const importerId = moduleId(path);
    const stripped = stripComments(source);
    for (const regex of [VALUE_IMPORT_SOURCE, VALUE_EXPORT_SOURCE]) {
      for (const match of stripped.matchAll(regex)) {
        const targetId = resolveImport(importerId, match[1], modules);
        if (targetId) {
          graph.get(importerId)?.add(targetId);
        }
      }
    }
  }

  return graph;
}

function findStronglyConnectedComponents(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const components: string[][] = [];

  function visit(node: string): void {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node) ?? 0, lowLinkByNode.get(target) ?? 0),
        );
      } else if (onStack.has(target)) {
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node) ?? 0, indexByNode.get(target) ?? 0),
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (current === undefined) break;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components;
}

describe("import cycle budget guard", () => {
  it("does not grow the largest static value-import cycle", () => {
    const graph = buildValueImportGraph();
    const cyclicComponents = findStronglyConnectedComponents(graph)
      .filter((component) => component.length > 1)
      .sort((left, right) => right.length - left.length);
    const largest = cyclicComponents[0] ?? [];

    expect(
      largest.length,
      `Largest static value-import SCC grew past ${MAX_LARGEST_SCC_SIZE}. ` +
        `Break feature/API cycles before increasing this budget.\n` +
        largest.sort().map((id) => `  - ${id}`).join("\n"),
    ).toBeLessThanOrEqual(MAX_LARGEST_SCC_SIZE);
  });
});
