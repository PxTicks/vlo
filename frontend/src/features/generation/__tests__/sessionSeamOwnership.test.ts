import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The N3 ownership gate
 * (docs/generation-native-extension-seams-plan.md §5, N3 first bullet).
 *
 * The generation session and the normalized graph-effect path are owner-neutral
 * by design: the generation feature mounts them, native controls write through
 * them, and a trusted adapter *may* project them. Nothing in that closure may
 * depend on extension ownership — not owner types, not activation scopes, not
 * SDK limits — because core code importing the adapter is what turns a shared
 * seam back into an extension-shaped one.
 *
 * A grep of the seam's own files would miss the interesting case: a helper five
 * modules down that quietly reaches for `ExtensionApiScope`. So this walks the
 * whole relative-import closure instead.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The seam certified by N1, N2, and N2b. */
const SEAM_ROOTS = [
  "../services/GenerationSessionService.ts",
  "../services/generationSessionTypes.ts",
  "../services/generationSessionValidation.ts",
  "../services/workflowNodeCatalogue.ts",
  "../pipeline/generationGraphEffects.ts",
].map((entry) => resolve(HERE, entry));

const FORBIDDEN = /features\/extensions/;

function resolveImport(fromFile: string, specifier: string): string | null {
  // Package and alias imports leave the repository's source tree; only
  // relative specifiers can pull in another first-party module.
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface SeamClosure {
  readonly modules: ReadonlySet<string>;
  readonly violations: readonly string[];
}

function walkSeam(): SeamClosure {
  const modules = new Set<string>();
  const violations: string[] = [];

  const visit = (file: string): void => {
    if (modules.has(file)) return;
    modules.add(file);
    const source = readFileSync(file, "utf8");
    // Covers `import … from "x"`, `export … from "x"`, and type-only forms,
    // which all share the `from "…"` tail.
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (FORBIDDEN.test(specifier)) {
        violations.push(`${relative(HERE, file)} -> ${specifier}`);
      }
      const resolved = resolveImport(file, specifier);
      if (resolved) visit(resolved);
    }
  };

  for (const root of SEAM_ROOTS) visit(root);
  return { modules, violations };
}

describe("generation session seam ownership", () => {
  it("keeps extension ownership out of the session and effect closure", () => {
    const { violations } = walkSeam();
    expect(violations).toEqual([]);
  });

  it("walks a closure large enough to be meaningful", () => {
    // Guards the guard: a resolver regression that silently resolved nothing
    // would make the assertion above pass by walking one file per root.
    const { modules } = walkSeam();
    expect(modules.size).toBeGreaterThan(SEAM_ROOTS.length * 2);
  });
});
