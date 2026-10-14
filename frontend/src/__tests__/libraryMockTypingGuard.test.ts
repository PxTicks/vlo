import { describe, expect, it } from "vitest";

const RAW_FILES = import.meta.glob("../**/*.test.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Libraries whose wholesale test mocks must be typed against the installed
 * declarations. A mock that invents its own shapes agrees with whatever the
 * code under test assumes: the export probe read Pixi's extract.pixels() as a
 * bare buffer, and a hand-written mock returning a bare buffer kept it green.
 */
const TYPED_LIBRARIES = ["pixi.js", "mediabunny"];

const TYPED_FAKE_MARKERS = [
  "libraryFakes",
  "implements Partial<",
  "satisfies Partial<",
  "vi.fn<typeof import(",
];

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function libraryMockCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(
    `vi\\.mock\\("(?:${TYPED_LIBRARIES.map((name) => name.replace(".", "\\.")).join("|")})",`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    const open = match.index + "vi.mock".length;
    calls.push(source.slice(open, matchingParen(source, open) + 1));
  }
  return calls;
}

/**
 * Fake classes with members but no `implements` clause or typed base. A class
 * whose real counterpart has no public members to check against may opt out
 * with an `// untyped: <reason>` comment on the line above it.
 */
function untypedFakeClasses(mockCall: string): string[] {
  const classPattern =
    /class(?:\s+\w+)?(?:\s+extends\s+[\w.()<>"]+)?(?:\s+implements\s+[^{]+)?\s*\{(?!\s*\})/g;
  return [...mockCall.matchAll(classPattern)]
    .filter((match) => {
      const lineStart = mockCall.lastIndexOf("\n", match.index) + 1;
      const previousLineStart = mockCall.lastIndexOf("\n", lineStart - 2) + 1;
      const previousLine = mockCall.slice(previousLineStart, lineStart);
      return !previousLine.includes("// untyped:");
    })
    .map((match) => match[0])
    .filter((head) => !/\b(implements|extends)\b/.test(head));
}

describe("library mock typing", () => {
  const offenders = Object.entries(RAW_FILES).flatMap(([path, source]) => {
    const calls = libraryMockCalls(source);
    if (calls.length === 0) return [];
    const problems: string[] = [];
    if (!TYPED_FAKE_MARKERS.some((marker) => source.includes(marker))) {
      problems.push("no typed fakes (see testUtils/libraryFakes)");
    }
    for (const call of calls) {
      for (const head of untypedFakeClasses(call)) {
        problems.push(`untyped fake class: ${head.trim()}`);
      }
    }
    const file = path.replace(/^\.\.\//, "src/").replace(/^\.\//, "src/__tests__/");
    return problems.map((problem) => `${file}: ${problem}`);
  });

  it("types every Pixi and mediabunny test mock against the real library", () => {
    expect(offenders).toEqual([]);
  });

  it("scans the test files that replace these libraries", () => {
    const mockingFiles = Object.values(RAW_FILES).filter(
      (source) => libraryMockCalls(source).length > 0,
    );
    expect(mockingFiles.length).toBeGreaterThan(30);
  });
});
