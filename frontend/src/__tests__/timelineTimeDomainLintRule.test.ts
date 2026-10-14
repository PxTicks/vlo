import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import rule from "../../eslint-rules/no-incompatible-timeline-time-arithmetic.js";

const linter = new Linter();
const config = [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["timeline-time-domain-lint-fixture.ts"],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      "time-domains": {
        rules: { incompatible: rule },
      },
    },
    rules: {
      "time-domains/incompatible": "error" as const,
    },
  },
];

function lint(expression: string, lenient = false) {
  return linter.verify(
    `
      type PresentationTick = number & {
        readonly __timelineTimeDomain?: "presentation";
      };
      type StoredTrackTick = number & {
        readonly __timelineTimeDomain?: "stored-track";
      };
      declare const presentation: PresentationTick;
      declare const stored: StoredTrackTick;
      declare const otherPresentation: PresentationTick;
      ${expression};
    `,
    [{ ...config[0], rules: { "time-domains/incompatible": ["error", { lenient }] } }],
    { filename: "timeline-time-domain-lint-fixture.ts" },
  );
}

// The first lint call boots the TypeScript project service, which takes far
// longer than the default timeout when the coverage run saturates every core.
describe("no-incompatible-timeline-time-arithmetic", { timeout: 30_000 }, () => {
  it("rejects arithmetic and comparisons across timeline domains", () => {
    for (const expression of [
      "presentation - stored",
      "presentation + stored",
      "presentation < stored",
      "presentation === stored",
    ]) {
      expect(lint(expression)).toEqual([
        expect.objectContaining({
          ruleId: "time-domains/incompatible",
          severity: 2,
          message: expect.stringContaining("presentation and stored-track"),
        }),
      ]);
    }
  });

  it("allows operations within one explicitly branded domain", () => {
    expect(lint("presentation - otherPresentation")).toEqual([]);
  });

  it("rejects arithmetic that silently drops into an untyped number", () => {
    expect(lint("presentation - 10")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("presentation and untyped-number"),
      }),
    ]);
  });
});


describe("lenient domain enforcement", () => {
  it("keeps domains through aliases and stored extent arithmetic", () => {
    for (const expression of [
      "const clipStart = stored; Math.max(clipStart, presentation)",
      "const clipEnd = stored + 100; Math.min(presentation, clipEnd)",
      "declare function clamp(value: number, min: number, max: number): number; clamp(presentation, stored, stored + 100)",
    ]) expect(lint(expression, true)).toHaveLength(1);
  });
  it("permits duration literals without permitting another clock", () => {
    expect(lint("stored + 100", true)).toEqual([]);
    expect(lint("presentation - stored", true)).toHaveLength(1);
  });
});
