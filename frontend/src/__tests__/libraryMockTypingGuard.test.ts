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
 *
 * Typing the fake is not enough on its own. An unparameterised `vi.fn()`
 * returns `any`, which satisfies every member type, so a spy that becomes a
 * library member must carry the member's signature (`vi.fn<T["name"]>()`)
 * before a test configures what it returns.
 */
const TYPED_LIBRARIES = ["pixi.js", "mediabunny"];

const TYPED_FAKE_MARKERS = [
  "libraryFakes",
  "implements Partial<",
  "satisfies Partial<",
  "vi.fn<typeof import(",
];

const OPENERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
const CLOSERS = new Set(Object.values(OPENERS));

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index;
  }
  return text.length;
}

/**
 * Index of the last character of a string literal or comment starting at
 * `start`, or -1 when none starts there. Comments matter: an apostrophe in
 * "Pixi's" would otherwise open a string and derail bracket matching.
 */
function skipLiteral(text: string, start: number): number {
  const char = text[start];
  if (char === '"' || char === "'" || char === "`") return skipString(text, start);
  if (char === "/" && text[start + 1] === "/") {
    const end = text.indexOf("\n", start);
    return end === -1 ? text.length : end;
  }
  if (char === "/" && text[start + 1] === "*") {
    const end = text.indexOf("*/", start + 2);
    return end === -1 ? text.length : end + 1;
  }
  return -1;
}

/** `source` with comments blanked out, preserving offsets. */
function withoutComments(source: string): string {
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const end = skipLiteral(source, index);
    if (end === -1) {
      out += source[index];
      continue;
    }
    const literal = source.slice(index, end + 1);
    out += literal.startsWith("/")
      ? literal.replace(/[^\n]/g, " ")
      : literal;
    index = end;
  }
  return out;
}

function matchForward(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") index = skipString(text, index);
    else if (char in OPENERS) depth += 1;
    else if (CLOSERS.has(char)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function matchBack(text: string, close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const char = text[index];
    if (CLOSERS.has(char)) depth += 1;
    else if (char in OPENERS) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return 0;
}

function genericEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "<") depth += 1;
    else if (text[index] === ">" && text[index - 1] !== "=") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

interface Region {
  start: number;
  end: number;
}

function libraryMockCalls(source: string): Region[] {
  const pattern = new RegExp(
    `vi\\.mock\\("(?:${TYPED_LIBRARIES.map((name) => name.replace(".", "\\.")).join("|")})",`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => {
    const open = match.index + "vi.mock".length;
    return { start: open, end: matchForward(source, open) };
  });
}

/** Bodies whose members are checked against a library type. */
function typedBodies(source: string): Region[] {
  const bodies: Region[] = [];
  for (const match of source.matchAll(/fake</g)) {
    const afterGeneric = genericEnd(source, match.index + "fake".length);
    const brace = source.slice(afterGeneric).match(/^\(\s*\{/);
    if (!brace) continue;
    const open = afterGeneric + brace[0].length - 1;
    bodies.push({ start: open, end: matchForward(source, open) });
  }
  for (const match of source.matchAll(/\}\s*satisfies Partial</g)) {
    bodies.push({ start: matchBack(source, match.index), end: match.index });
  }
  for (const match of source.matchAll(/implements Partial</g)) {
    const afterGeneric = genericEnd(source, match.index + match[0].length - 1);
    const open = source.indexOf("{", afterGeneric);
    bodies.push({ start: open, end: matchForward(source, open) });
  }
  return bodies;
}

/** `name: vi.fn(` / `name = vi.fn(` members directly inside a body. */
function untypedMemberSpies(source: string, body: Region): string[] {
  const names: string[] = [];
  const member = /(?:readonly\s+)?(\w+)\s*[:=]\s*vi\.fn(?=[(<])/y;
  let depth = 0;
  for (let index = body.start; index <= body.end; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
      continue;
    }
    if (char in OPENERS) depth += 1;
    else if (CLOSERS.has(char)) depth -= 1;
    else if (depth === 1 && !/[\w.]/.test(source[index - 1] ?? "")) {
      member.lastIndex = index;
      const match = member.exec(source);
      if (!match) continue;
      if (source[member.lastIndex] !== "<") names.push(match[1]);
      index = member.lastIndex;
    }
  }
  return names;
}

/** Fake classes with members but no `implements` clause or typed base. */
function untypedFakeClasses(mockCall: string): string[] {
  const classPattern =
    /class(?:\s+\w+)?(?:\s+extends\s+[\w.()<>"]+)?(?:\s+implements\s+[^{]+)?\s*\{(?!\s*\})/g;
  return [...mockCall.matchAll(classPattern)]
    .filter((match) => {
      const lineStart = mockCall.lastIndexOf("\n", match.index) + 1;
      const previousLineStart = mockCall.lastIndexOf("\n", lineStart - 2) + 1;
      return !mockCall.slice(previousLineStart, lineStart).includes("// untyped:");
    })
    .map((match) => match[0])
    .filter((head) => !/\b(implements|extends)\b/.test(head));
}

/**
 * Unparameterised spies defined in `vi.hoisted` blocks and referenced from a
 * library mock or typed fake, where they flow in as `any`.
 */
function untypedHoistedSpies(source: string, libraryRegions: Region[]): string[] {
  const libraryText = libraryRegions
    .map((region) => source.slice(region.start, region.end + 1))
    .join("\n");
  const names = new Set<string>();
  for (const match of source.matchAll(/vi\.hoisted\(/g)) {
    const open = match.index + "vi.hoisted".length;
    const hoisted = source.slice(open, matchForward(source, open) + 1);
    for (const spy of hoisted.matchAll(/(?:(\w+)\s*:|const\s+(\w+)\s*=)\s*vi\.fn\(\)/g)) {
      const name = spy[1] ?? spy[2];
      const referenced = new RegExp(`(?:\\.|[^\\w.])${name}\\b(?!\\s*:)`).test(libraryText);
      if (referenced) names.add(name);
    }
  }
  return [...names];
}

function problemsIn(rawSource: string): string[] {
  const source = withoutComments(rawSource);
  const mockCalls = libraryMockCalls(source);
  if (mockCalls.length === 0) return [];
  const problems: string[] = [];
  if (!TYPED_FAKE_MARKERS.some((marker) => rawSource.includes(marker))) {
    problems.push("no typed fakes (see testUtils/libraryFakes)");
  }
  for (const call of mockCalls) {
    for (const head of untypedFakeClasses(rawSource.slice(call.start, call.end + 1))) {
      problems.push(`untyped fake class: ${head.trim()}`);
    }
  }
  const bodies = typedBodies(source);
  for (const body of bodies) {
    for (const name of untypedMemberSpies(source, body)) {
      problems.push(`spy member '${name}' needs its library signature: vi.fn<T["${name}"]>()`);
    }
  }
  for (const name of untypedHoistedSpies(source, [...mockCalls, ...bodies])) {
    problems.push(`hoisted spy '${name}' reaches a library fake untyped`);
  }
  return problems;
}

describe("library mock typing", () => {
  const offenders = Object.entries(RAW_FILES).flatMap(([path, source]) => {
    const file = path.replace(/^\.\.\//, "src/").replace(/^\.\//, "src/__tests__/");
    return problemsIn(source).map((problem) => `${file}: ${problem}`);
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

  it("rejects untyped spies that a typed fake would otherwise accept", () => {
    const sample = [
      'vi.mock("pixi.js", () => ({}));',
      'import { fake } from "../testUtils/libraryFakes";',
      "const mocks = vi.hoisted(() => ({ dispose: vi.fn() }));",
      "const extract = fake<ExtractSystem>({",
      "  pixels: vi.fn().mockReturnValue(new Uint8Array(4)),",
      "});",
      "class Track implements Partial<InputVideoTrack> {",
      "  dispose = mocks.dispose;",
      "}",
    ].join("\n");
    expect(problemsIn(sample)).toEqual([
      `spy member 'pixels' needs its library signature: vi.fn<T["pixels"]>()`,
      "hoisted spy 'dispose' reaches a library fake untyped",
    ]);
  });
});
