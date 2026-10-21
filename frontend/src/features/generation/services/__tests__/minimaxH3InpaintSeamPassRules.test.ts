import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateRewrites, type RewriteRule } from "../evaluateRewrites";
import {
  buildFrontendStateControlKey,
  buildFrontendStateWidgetKey,
  createFrontendRuleState,
  evaluateGenerationMaskGrow,
} from "../frontendRuleState";
import type { WorkflowRules } from "../workflowRules/types";

/**
 * The MiniMax H3 inpaint workflows end with a seam pass that repaints a band
 * across the snapped mask edge (node 115 switches it in). Its kept-side band
 * (node 105, in 16 px latent cells) repaints original content past the mask,
 * so the attached mask grows to cover it: the pixel mask grow (103), up to one
 * 32 px token of snapping, and the band. With the pass off nothing is grown.
 * The pass ships off; the tests that need it on switch it on.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config",
);
const MODES = ["default_workflows", "high_vram_workflows"] as const;
const STEMS = ["vlo_minimax_h3_inpaint", "vlo_minimax_h3_inpaint_flf2va"] as const;
const SEAM_LORA_ID = "116";

function loadRules(dir: string, stem: string): WorkflowRules {
  return JSON.parse(
    readFileSync(resolve(CONFIG_DIR, dir, `${stem}.rules.json`), "utf-8"),
  ) as WorkflowRules;
}

function widgetDefault(
  rules: WorkflowRules,
  nodeId: string,
  widget: string,
): unknown {
  return rules.nodes?.[nodeId]?.widgets?.[widget]?.default;
}

function panelValues(
  rules: WorkflowRules,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [buildFrontendStateWidgetKey("115", "switch")]: widgetDefault(rules, "115", "switch"),
    [buildFrontendStateWidgetKey("103", "expand")]: widgetDefault(rules, "103", "expand"),
    [buildFrontendStateWidgetKey("105", "expand")]: widgetDefault(rules, "105", "expand"),
    [buildFrontendStateControlKey("seam_lora_enabled")]:
      rules.frontend_controls?.seam_lora_enabled?.default,
    ...overrides,
  };
}

function grow(rules: WorkflowRules, values: Record<string, unknown>) {
  return evaluateGenerationMaskGrow(
    rules,
    createFrontendRuleState(new Set(), values),
  );
}

function bypassed(rules: WorkflowRules, values: Record<string, unknown>) {
  return new Set(
    evaluateRewrites(
      (rules.rewrites as RewriteRule[] | undefined) ?? [],
      new Set(),
      values,
    ).bypass,
  );
}

describe.each(MODES)("MiniMax H3 inpaint seam pass in %s", (dir) => {
  describe.each(STEMS)("%s", (stem) => {
    const rules = loadRules(dir, stem);

    it("ships off, with a 16 px kept band, a 64 px generated band and 4 steps", () => {
      expect(widgetDefault(rules, "115", "switch")).toBe(false);
      expect(widgetDefault(rules, "105", "expand")).toBe(1);
      expect(widgetDefault(rules, "107", "expand")).toBe(4);
      expect(rules.nodes?.["105"]?.widgets?.expand?.display_unit?.scale).toBe(16);
      expect(widgetDefault(rules, "112", "steps")).toBe(4);
    });

    it("does not grow the mask at defaults, with the pass off", () => {
      expect(grow(rules, panelValues(rules))).toBeNull();
    });

    it("grows the mask by the snapping margin plus the default kept band once on", () => {
      const values = panelValues(rules, {
        [buildFrontendStateWidgetKey("115", "switch")]: true,
      });
      expect(grow(rules, values)).toBe(32 + 16);
    });

    it("adds the pixel mask grow and scales the band by its cell size", () => {
      const values = panelValues(rules, {
        [buildFrontendStateWidgetKey("115", "switch")]: true,
        [buildFrontendStateWidgetKey("103", "expand")]: 12,
        [buildFrontendStateWidgetKey("105", "expand")]: 3,
      });
      expect(grow(rules, values)).toBe(12 + 32 + 48);
    });

    it("does not grow the mask when the seam pass is off", () => {
      const values = panelValues(rules, {
        [buildFrontendStateWidgetKey("115", "switch")]: false,
      });
      expect(grow(rules, values)).toBeNull();
    });

    it("keeps the seam LoRA only while the pass runs and the toggle is on", () => {
      const on = { [buildFrontendStateWidgetKey("115", "switch")]: true };
      // Off by default, so a fresh panel never needs the LoRA file.
      expect(bypassed(rules, panelValues(rules)).has(SEAM_LORA_ID)).toBe(true);
      expect(bypassed(rules, panelValues(rules, on)).has(SEAM_LORA_ID)).toBe(false);
      expect(
        bypassed(
          rules,
          panelValues(rules, {
            ...on,
            [buildFrontendStateControlKey("seam_lora_enabled")]: false,
          }),
        ).has(SEAM_LORA_ID),
      ).toBe(true);
    });
  });
});
