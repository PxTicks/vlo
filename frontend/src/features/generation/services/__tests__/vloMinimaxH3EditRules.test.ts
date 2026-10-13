import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";

/**
 * Both H3 image edits rewrite the graph the same two ways: the accelerator
 * switch, and — on the reference edit — the optional video and audio branches,
 * which are dropped when the user attaches none.
 *
 * The two workflows number Spectrum differently, which is exactly how a copied
 * rewrite ends up pointing at the wrong node, so the expected node is pinned
 * per workflow. Neither may ever bypass the source image: it is required, and
 * an empty image list has to fail validation rather than quietly turn the edit
 * into a text-to-video run.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config/default_workflows",
);

const CASES = [
  {
    workflow: "vlo_minimax_h3_edit",
    spectrumNode: "148",
    // The first-frame edit takes no further references.
    optionalRefNodes: [] as string[],
  },
  {
    workflow: "vlo_minimax_h3_edit_ref",
    spectrumNode: "146",
    optionalRefNodes: ["142", "143"],
  },
] as const;

const SOURCE_INPUT_IDS = ["141", "141:image"];

function loadRewrites(workflow: string): RewriteRule[] {
  const rules = JSON.parse(
    readFileSync(resolve(CONFIG_DIR, `${workflow}.rules.json`), "utf-8"),
  ) as { rewrites: RewriteRule[] };
  return rules.rewrites;
}

function bypassFor(
  rewrites: RewriteRule[],
  spectrumEnabled: boolean,
  provided: readonly string[] = SOURCE_INPUT_IDS,
): string[] {
  return evaluateRewrites(rewrites, new Set(provided), {
    frontend_control_spectrum_enabled: spectrumEnabled,
  }).bypass.sort();
}

describe.each(CASES)("$workflow rewrites", ({ workflow, spectrumNode, optionalRefNodes }) => {
  const rewrites = loadRewrites(workflow);

  it("drops the reference branches that have nothing in them", () => {
    expect(bypassFor(rewrites, true)).toEqual([...optionalRefNodes].sort());
  });

  it("keeps the reference branches once they are filled", () => {
    expect(bypassFor(rewrites, true, [...SOURCE_INPUT_IDS, ...optionalRefNodes])).toEqual(
      [],
    );
  });

  it("keeps the Spectrum patch while the control is on", () => {
    expect(
      bypassFor(rewrites, true, [...SOURCE_INPUT_IDS, ...optionalRefNodes]),
    ).toEqual([]);
  });

  it("bypasses the Spectrum patch when the control is off", () => {
    expect(bypassFor(rewrites, false)).toEqual(
      [...optionalRefNodes, spectrumNode].sort(),
    );
  });

  it("never bypasses the required source image", () => {
    for (const rule of rewrites) {
      expect(rule.bypass).not.toContain("141");
    }
  });
});
