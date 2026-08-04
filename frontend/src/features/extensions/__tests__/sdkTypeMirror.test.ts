import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `features/extensions/types.ts` is the host's complete mirror of the SDK, and
 * it is hand-maintained — so it drifts silently: a type added to the SDK
 * without a mirror entry is simply unavailable to host code, with no error
 * anywhere. It had drifted by six types before this test existed.
 *
 * Only the mirror is pinned. The feature barrel (`index.ts`) re-exports a
 * curated subset on purpose, per the repository's encapsulation convention,
 * so it is deliberately not asserted here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_PATH = resolve(
  HERE,
  "../../../../..",
  "packages/extension-sdk/src/index.ts",
);
const TYPES_PATH = resolve(HERE, "../types.ts");

function readNames(path: string, pattern: RegExp): Set<string> {
  const source = readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

function sdkExports(): Set<string> {
  return readNames(
    SDK_PATH,
    /^export (?:declare )?(?:interface|type|const|class|function) ([A-Za-z0-9_]+)/gm,
  );
}

/** Names inside a `export type { ... } from "..."` list. */
function reExportedNames(path: string): Set<string> {
  return readNames(path, /^\s{2}([A-Za-z][A-Za-z0-9_]*),$/gm);
}

describe("SDK type mirror", () => {
  it("re-exports every SDK type from features/extensions/types.ts", () => {
    const missing = [...sdkExports()].filter(
      (name) => !reExportedNames(TYPES_PATH).has(name),
    );
    expect(missing).toEqual([]);
  });

  it("does not claim exports the SDK no longer has", () => {
    const sdk = sdkExports();
    const stale = [...reExportedNames(TYPES_PATH)].filter(
      (name) => !sdk.has(name),
    );
    expect(stale).toEqual([]);
  });
});
