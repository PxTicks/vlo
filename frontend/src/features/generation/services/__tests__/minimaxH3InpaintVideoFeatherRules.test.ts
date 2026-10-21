import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";
import { buildFrontendStateControlKey } from "../frontendRuleState";
import type { WorkflowRules } from "../workflowRules/types";

/**
 * The MiniMax H3 inpaint workflows can feather the video mask in time (node
 * 117), which partially regenerates frames outside the mask. It ships off: the
 * panel toggle must be explicitly on for the node to run, so a submission with
 * no value for the toggle leaves it bypassed as well.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config",
);
const MODES = ["default_workflows", "high_vram_workflows"] as const;
const STEMS = [
  "vlo_minimax_h3_inpaint",
  "vlo_minimax_h3_inpaint_flf2va",
  "vlo_minimax_h3_fun_controlnet_union",
] as const;
const FEATHER_ID = "117";
const TOGGLE_ID = "video_feather_enabled";
// The ControlNet workflow drops its whole mask chain when no mask (input 1) is given.
const PROVIDED_INPUTS = new Set(["1"]);

function loadRules(dir: string, stem: string): WorkflowRules {
  return JSON.parse(
    readFileSync(resolve(CONFIG_DIR, dir, `${stem}.rules.json`), "utf-8"),
  ) as WorkflowRules;
}

function featherBypassed(
  rules: WorkflowRules,
  widgetValues: Record<string, unknown>,
): boolean {
  return evaluateRewrites(
    (rules.rewrites as RewriteRule[] | undefined) ?? [],
    PROVIDED_INPUTS,
    widgetValues,
  ).bypass.includes(FEATHER_ID);
}

describe.each(MODES)("MiniMax H3 video mask feather in %s", (dir) => {
  describe.each(STEMS)("%s", (stem) => {
    const rules = loadRules(dir, stem);
    const toggleKey = buildFrontendStateControlKey(TOGGLE_ID);

    it("is bypassed at the toggle's default", () => {
      const fallback = rules.frontend_controls?.[TOGGLE_ID]?.default;
      expect(fallback).toBe(false);
      expect(featherBypassed(rules, { [toggleKey]: fallback })).toBe(true);
    });

    it("is bypassed when the submission carries no toggle value", () => {
      expect(featherBypassed(rules, {})).toBe(true);
    });

    it("runs when the toggle is on", () => {
      expect(featherBypassed(rules, { [toggleKey]: true })).toBe(false);
    });
  });
});
