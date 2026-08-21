import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GenerationInputs } from "../GenerationInputs";
import type { WorkflowInput, WorkflowWidgetInput } from "../../types";

/**
 * The panel order the shipped MiniMax workflows are written against:
 *
 *   Inputs -> Prompts -> Video Generation -> LoRA loaders -> References
 *   -> Advanced Settings
 *
 * Pinned against the real rules files because nothing else fails when one of
 * them bumps a section `order`, and the sort has an edge that makes a mistake
 * quiet: a section carrying a numeric order always sorts ahead of one without,
 * so dropping an order sends a section to the bottom rather than leaving it
 * where it was.
 */
const CONFIG_DIR = resolve(
  __dirname,
  "../../../../../../backend/assets/.config",
);

const MODES = ["default_workflows", "high_vram_workflows"] as const;

interface WorkflowSectionRule {
  id: string;
  title?: string;
  order?: number;
  default_open?: boolean;
}

function loadSections(dir: string, workflow: string): WorkflowSectionRule[] {
  const path = resolve(CONFIG_DIR, dir, `${workflow}.rules.json`);
  return (
    JSON.parse(readFileSync(path, "utf-8")) as {
      sections?: WorkflowSectionRule[];
    }
  ).sections ?? [];
}

/** One media input, so the built-in "Inputs" panel has something to render. */
const MEDIA_INPUT: WorkflowInput = {
  id: "141:images",
  nodeId: "141",
  classType: "vloMemoryLoadImageBatch",
  inputType: "image",
  param: "images",
  label: "Image inputs",
  currentValue: null,
  origin: "rule",
  presentation: { section: { id: "inputs" } },
};

/** A text input lands in the built-in "Prompts" panel. */
const PROMPT_INPUT: WorkflowInput = {
  id: "136:prompt",
  nodeId: "136",
  classType: "vloMiniMaxH3ReferenceToVideoBatch",
  inputType: "text",
  param: "prompt",
  label: "Prompt",
  currentValue: "",
  origin: "rule",
};

function widget(
  nodeId: string,
  param: string,
  label: string,
  sectionId?: string,
): WorkflowWidgetInput {
  return {
    nodeId,
    param,
    currentValue: 1,
    config: {
      label,
      controlAfterGenerate: false,
      valueType: "int",
      ...(sectionId ? { sectionId } : {}),
    },
  };
}

function renderPanel(
  sections: WorkflowSectionRule[],
  widgetInputs: WorkflowWidgetInput[],
) {
  render(
    <GenerationInputs
      inputs={[MEDIA_INPUT, PROMPT_INPUT]}
      sections={sections}
      textValues={{}}
      onTextValueCommit={vi.fn()}
      mediaInputs={{}}
      onInputDrop={vi.fn()}
      onExternalInputDrop={vi.fn()}
      onInputClear={vi.fn()}
      onSwapMediaInputs={vi.fn()}
      onMoveMediaInput={vi.fn()}
      onClickSelect={vi.fn()}
      widgetInputs={widgetInputs}
      widgetValues={{}}
      randomizeToggles={{}}
      onWidgetChange={vi.fn()}
      onToggleRandomize={vi.fn()}
    />,
  );
}

/** Assert the labels appear top to bottom in the given order. */
function expectOrder(labels: readonly string[]): void {
  const found = labels.map((label) => screen.getByText(label));
  for (let index = 0; index + 1 < found.length; index += 1) {
    expect(
      found[index].compareDocumentPosition(found[index + 1]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      `${labels[index]} should come before ${labels[index + 1]}`,
    ).not.toBe(0);
  }
}

describe("shipped MiniMax workflow section order", () => {
  it.each(MODES)("orders the i2v panel in %s", (dir) => {
    // i2v declares only the two trailing sections; its generation controls
    // carry no section_id and so land in the built-in "Settings" panel.
    renderPanel(loadSections(dir, "vlo_minimax_h3_i2v"), [
      widget("151", "attention", "Attention backend", "advanced_settings"),
      widget("150", "lora_name", "Model", "lora_loaders"),
      widget("124", "steps", "Steps"),
    ]);

    expectOrder([
      "Image inputs",
      "Prompt",
      "Settings",
      "LoRA loaders",
      "Advanced Settings",
    ]);
  });

  it.each(MODES)("orders the r2v panel in %s", (dir) => {
    // Passed in an order matching neither the declaration nor the expectation,
    // so the assertion cannot pass by accident of iteration order.
    renderPanel(loadSections(dir, "vlo_minimax_h3_r2v"), [
      widget("136", "ref_image_size", "Reference image size", "references"),
      widget("145", "attention", "Attention backend", "advanced_settings"),
      widget("148", "lora_name", "Model", "lora_loaders"),
      widget("129", "noise_seed", "Noise seed", "video_generation"),
    ]);

    expectOrder([
      "Image inputs",
      "Prompt",
      "Video Generation",
      "LoRA loaders",
      "References",
      "Advanced Settings",
    ]);
  });

  it.each(MODES)("keeps advanced settings last and collapsed in %s", (dir) => {
    for (const workflow of ["vlo_minimax_h3_i2v", "vlo_minimax_h3_r2v"]) {
      const sections = loadSections(dir, workflow);
      const advanced = sections.find((s) => s.id === "advanced_settings");
      expect(advanced?.default_open).toBe(false);
      expect(Math.max(...sections.map((s) => s.order ?? -1))).toBe(
        advanced?.order,
      );
    }
  });
});
