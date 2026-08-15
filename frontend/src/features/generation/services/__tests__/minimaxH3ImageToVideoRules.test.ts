import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";

/**
 * Both keyframes may be left empty here (as in vlo_ltx2_3), so an unfilled
 * input has to drop its loader out of the prompt on its own — otherwise the
 * loader executes and pulls whatever its filename widget resolved to.
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
  it("bypasses both loaders when neither frame is set", () => {
    expect(bypassFor([])).toEqual(["141", "142"]);
  });

  it("keeps only the start-frame loader when just the start frame is set", () => {
    expect(bypassFor(["141"])).toEqual(["142"]);
  });

  it("keeps only the end-frame loader when just the end frame is set", () => {
    expect(bypassFor(["142"])).toEqual(["141"]);
  });

  it("bypasses nothing when both frames are set", () => {
    expect(bypassFor(["141", "142"])).toEqual([]);
  });
});
