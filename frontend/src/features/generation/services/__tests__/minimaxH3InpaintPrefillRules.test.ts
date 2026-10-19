import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  evaluateEffectSwitchesForState,
  evaluateRewrites,
  type RewriteRule,
} from "../evaluateRewrites";
import {
  buildFrontendStateControlKey,
  buildFrontendStateWidgetKey,
} from "../frontendRuleState";
import type { WorkflowRules } from "../workflowRules/types";

/**
 * The MiniMax H3 inpaint workflows fill the masked area (node 104) before
 * encoding. Below unit denoise the masked content is the sampler's starting
 * point, so the fill must never run there, whatever the panel toggle says.
 * Submission bypasses the union of rewrite and effect-switch bypasses, so the
 * two are evaluated together here exactly as generationGraphEffects does.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config",
);
const MODES = ["default_workflows", "high_vram_workflows"] as const;
const STEMS = ["vlo_minimax_h3_inpaint", "vlo_minimax_h3_inpaint_flf2va"] as const;
const FILL_ID = "104";

function loadRules(dir: string, stem: string): WorkflowRules {
  return JSON.parse(
    readFileSync(resolve(CONFIG_DIR, dir, `${stem}.rules.json`), "utf-8"),
  ) as WorkflowRules;
}

function bypassedNodes(
  rules: WorkflowRules,
  denoise: unknown,
  prefillEnabled: boolean,
): Set<string> {
  const widgetValues = {
    [buildFrontendStateWidgetKey("37", "denoise")]: denoise,
    [buildFrontendStateControlKey("prefill_enabled")]: prefillEnabled,
  };
  const rewrites = evaluateRewrites(
    (rules.rewrites as RewriteRule[] | undefined) ?? [],
    new Set(),
    widgetValues,
  );
  const switches = evaluateEffectSwitchesForState(
    rules.effect_switches ?? [],
    new Set(),
    widgetValues,
  );
  return new Set([...rewrites.bypass, ...switches.bypass]);
}

describe.each(MODES)("MiniMax H3 inpaint pre-encode fill in %s", (dir) => {
  describe.each(STEMS)("%s", (stem) => {
    const rules = loadRules(dir, stem);

    it("runs at unit denoise when the toggle is on", () => {
      expect(bypassedNodes(rules, 1, true).has(FILL_ID)).toBe(false);
    });

    it.each([0.99, 0.5, 0.01, 0, "0.5"])(
      "never runs at denoise %s, even with the toggle on",
      (denoise) => {
        expect(bypassedNodes(rules, denoise, true).has(FILL_ID)).toBe(true);
      },
    );

    it("is off when the toggle is off", () => {
      expect(bypassedNodes(rules, 1, false).has(FILL_ID)).toBe(true);
    });
  });
});
