import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";

/**
 * H3 image edit's only rewrite is the accelerator switch. Spectrum caches
 * sampling steps, so turning it off has to bypass the patch node rather than
 * leave it in the graph. The source image has no rewrite at all: it is required,
 * and nothing may drop it out of the prompt.
 */
const RULES_PATH = resolve(
  __dirname,
  "../../../../../../backend/assets/.config/default_workflows/vlo_minimax_h3_edit.rules.json",
);

const rules = JSON.parse(readFileSync(RULES_PATH, "utf-8")) as {
  rewrites: RewriteRule[];
};

// Media inputs register under both their node id and "<nodeId>:<param>".
const SOURCE_INPUT_IDS = new Set(["141", "141:image"]);

function bypassFor(spectrumEnabled: boolean): string[] {
  return evaluateRewrites(rules.rewrites, SOURCE_INPUT_IDS, {
    frontend_control_spectrum_enabled: spectrumEnabled,
  }).bypass;
}

describe("vlo_minimax_h3_edit rewrites", () => {
  it("keeps the Spectrum patch while the control is on", () => {
    expect(bypassFor(true)).toEqual([]);
  });

  it("bypasses the Spectrum patch when the control is off", () => {
    expect(bypassFor(false)).toEqual(["148"]);
  });

  it("declares no input-presence rewrite, so the source image is never dropped", () => {
    expect(rules.rewrites.every((rule) => rule.when.kind !== "input_presence")).toBe(
      true,
    );
  });
});
