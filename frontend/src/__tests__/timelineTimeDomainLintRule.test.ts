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

function lint(expression: string) {
  return linter.verify(
    `
      type PresentationTick = number & {
        readonly __timelineTimeDomain: "presentation";
      };
      type StoredTrackTick = number & {
        readonly __timelineTimeDomain: "stored-track";
      };
      declare const presentation: PresentationTick;
      declare const stored: StoredTrackTick;
      declare const otherPresentation: PresentationTick;
      ${expression};
    `,
    config,
    { filename: "timeline-time-domain-lint-fixture.ts" },
  );
}

describe("no-incompatible-timeline-time-arithmetic", () => {
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
