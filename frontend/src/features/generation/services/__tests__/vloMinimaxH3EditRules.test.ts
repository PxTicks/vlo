import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";

/**
 * Both H3 image edits have exactly one rewrite: the accelerator switch.
 * Spectrum caches sampling steps, so turning it off has to bypass the patch
 * node rather than leave it in the graph. The source image has no rewrite at
 * all — it is required, and nothing may drop it out of the prompt.
 *
 * The two workflows number Spectrum differently, which is exactly how a copied
 * rewrite ends up pointing at the wrong node, so the expected node is pinned
 * per workflow.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config/default_workflows",
);

const CASES = [
  { workflow: "vlo_minimax_h3_edit", spectrumNode: "148" },
  { workflow: "vlo_minimax_h3_edit_ref", spectrumNode: "146" },
] as const;

// Media inputs register under both their node id and "<nodeId>:<param>".
const SOURCE_INPUT_IDS = new Set(["141", "141:image"]);

function loadRewrites(workflow: string): RewriteRule[] {
  const rules = JSON.parse(
    readFileSync(resolve(CONFIG_DIR, `${workflow}.rules.json`), "utf-8"),
  ) as { rewrites: RewriteRule[] };
  return rules.rewrites;
}

function bypassFor(rewrites: RewriteRule[], spectrumEnabled: boolean): string[] {
  return evaluateRewrites(rewrites, SOURCE_INPUT_IDS, {
    frontend_control_spectrum_enabled: spectrumEnabled,
  }).bypass;
}

describe.each(CASES)("$workflow rewrites", ({ workflow, spectrumNode }) => {
  const rewrites = loadRewrites(workflow);

  it("keeps the Spectrum patch while the control is on", () => {
    expect(bypassFor(rewrites, true)).toEqual([]);
  });

  it("bypasses the Spectrum patch when the control is off", () => {
    expect(bypassFor(rewrites, false)).toEqual([spectrumNode]);
  });

  it("never bypasses the required source image", () => {
    expect([...rewrites].flatMap((rule) => rule.bypass)).not.toContain("141");
  });
});
