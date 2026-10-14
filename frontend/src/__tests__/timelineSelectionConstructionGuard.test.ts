import ts from "typescript";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

function hasSelectionConstruction(file: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.flatMap((property) => property.name ? [property.name.getText(file).replace(/["']/g, "")] : []);
      if (names.some((name) => ["version", "anchor", "durationTicks", "region", "isPoint"].includes(name))) {
        // Resolve spreads and aliases, including region: nextRegion. Hint-only
        // copies remain legal; reconstructing or overriding geometry does not.
        const type = checker.getTypeAtLocation(node);
        if (["version", "anchor", "durationTicks", "region"].every((name) => type.getProperty(name))) found = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

it("constructs and changes selection geometry only in the timing boundary", () => {
  const paths = Object.keys(sources).filter((path) =>
    !path.includes("__tests__") && !path.includes(".test.") && !path.includes("/timeline/time/"),
  ).map((path) => resolve(process.cwd(), "src/__tests__", path));
  const program = ts.createProgram(paths, compilerOptions);
  const checker = program.getTypeChecker();
  const violations = paths.filter((path) => {
    const file = program.getSourceFile(path);
    return file && hasSelectionConstruction(file, checker);
  }).map((path) => path.replace(process.cwd(), ""));
  expect(violations).toEqual([]);
  // Type-checks the whole source tree; the coverage run starves it of CPU.
}, 90_000);

function checkExample(source: string): boolean {
  const file = ts.createSourceFile("example.ts", `
    interface TimelineSelection { version: 2; anchor: number; durationTicks: number; region: { clips: unknown[] }; isPoint?: true }
    declare const selection: TimelineSelection;
    const narrowed = selection;
    const nextRegion = selection.region;
    declare const clips: unknown[];
    ${source}
  `, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (name) => name === file.fileName ? file : undefined;
  const program = ts.createProgram([file.fileName], compilerOptions, host);
  return hasSelectionConstruction(file, program.getTypeChecker());
}

it.each([
  "const s = { version: 2, anchor: 0, durationTicks: 10, region: {} };",
  "const s = { ...narrowed, anchor: 8 };",
  "const s = { ...selection, region: { ...selection.region, clips } };",
  "const s = { ...selection, region: nextRegion };",
  "const s = { ...selection, isPoint: true };",
])("detects selection geometry through spreads and aliases: %s", (source) => {
  expect(checkExample(source)).toBe(true);
});

it("allows hint copies and geometry arguments passed to the boundary", () => {
  expect(checkExample("const s = { ...selection, fps: 8 };")).toBe(false);
  expect(checkExample("updateTimelineSelection(selection, { anchor: 8 });")).toBe(false);
});
