import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";

/**
 * Both keyframes may be left empty here (as in vlo_ltx2_3), so an unfilled
 * input has to drop its loader and resize branch out of the prompt — otherwise
 * the loader executes and pulls whatever its filename widget resolved to.
 */
const RULES_PATH = resolve(
  __dirname,
  "../../../../../../backend/assets/.config/default_workflows/vlo_minimax_h3_i2v.rules.json",
);

const rules = JSON.parse(readFileSync(RULES_PATH, "utf-8")) as {
  rewrites: RewriteRule[];
};

function bypassFor(provided: string[]): string[] {
  // Media inputs register under both their node id and "<nodeId>:<param>".
  const providedInputIds = new Set(
    provided.flatMap((nodeId) => [nodeId, `${nodeId}:image`]),
  );
  return evaluateRewrites(rules.rewrites, providedInputIds).bypass.sort();
}

describe("vlo_minimax_h3_i2v rewrites", () => {
  it("bypasses both frame branches when neither frame is set", () => {
    expect(bypassFor([])).toEqual(["141", "142", "143", "144"]);
  });

  it("keeps only the start-frame branch when just the start frame is set", () => {
    expect(bypassFor(["141"])).toEqual(["142", "144"]);
  });

  it("keeps only the end-frame branch when just the end frame is set", () => {
    expect(bypassFor(["142"])).toEqual(["141", "143"]);
  });

  it("bypasses nothing when both frames are set", () => {
    expect(bypassFor(["141", "142"])).toEqual([]);
  });
});
