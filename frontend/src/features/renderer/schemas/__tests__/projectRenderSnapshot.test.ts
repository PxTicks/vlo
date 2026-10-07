import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detachedRenderDocumentSchema } from "../projectRenderSnapshot";

const root = resolve(process.cwd(), "../shared/fixtures/render");
const document: unknown = JSON.parse(readFileSync(resolve(root, "detached-render-document.json"), "utf8"));
/** `scope` came from the backend's schema split; every case is refused here. */
interface InvalidCase { name: string; scope: "structure" | "render"; path: (string | number)[]; value: unknown }
const invalidCases: InvalidCase[] = JSON.parse(readFileSync(resolve(root, "detached-render-document-invalid-cases.json"), "utf8"));

function patchedDocument(path: (string | number)[], replacement: unknown): unknown {
  const copy: unknown = structuredClone(document);
  let target = copy;
  for (const key of path.slice(0, -1)) target = (target as Record<string | number, unknown>)[key];
  (target as Record<string | number, unknown>)[path.at(-1)!] = replacement;
  return copy;
}

describe("detached render document contract", () => {
  it("represents trimmed layered media and unbounded still images", () => {
    const parsed = detachedRenderDocumentSchema.parse(document);
    expect(parsed.clips[0].offset).toBe(96_000);
    expect(parsed.clips[2].sourceDuration).toBeNull();
    expect(parsed.geometry.logicalWidth).not.toBe(parsed.geometry.outputWidth);
    expect(parsed.tracks.at(-1)?.isMuted).toBe(true);
    expect(detachedRenderDocumentSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each(invalidCases)("rejects $name", ({ path, value }) => {
    expect(detachedRenderDocumentSchema.safeParse(patchedDocument(path, value)).success).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite parameters: %s", (number) => {
    expect(detachedRenderDocumentSchema.safeParse(patchedDocument(["clips", 0, "transformations", 1, "parameters", "x"], number)).success).toBe(false);
  });

  it.each([
    ["a content digest", ["assets", 0, "digest"], `sha256:${"a".repeat(64)}`],
    ["a build digest", ["renderer", "buildDigest"], `sha256:${"1".repeat(64)}`],
    ["a project revision", ["project"], { id: "p", revision: "r" }],
  ])("names assets by ID only, refusing %s", (_name, path, value) => {
    expect(detachedRenderDocumentSchema.safeParse(patchedDocument(path, value)).success).toBe(false);
  });
});
