import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GenerationInputs } from "../GenerationInputs";
import { buildGenerationNodeCatalogue } from "../../services/workflowNodeCatalogue";
import { resolveWidgetInputs } from "../../services/workflowRules";
import {
  mergeAutodiscoveredLoraWidgetInputs,
  resolveAutodiscoveredLoraWidgetInputs,
} from "../../utils/loraLoaderWidgets";
import { reconcileNodeBypassWidgetTargets } from "../../utils/nodeBypassWidgets";

const LORA_WORKFLOW = {
  "12": {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["1", 0], lora_name: "detail.safetensors" },
    _meta: { title: "Detail LoRA" },
  },
};
const LORA_OBJECT_INFO = {
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [["base.safetensors", "detail.safetensors"], {}],
      },
    },
    input_order: { required: ["model", "lora_name"] },
  },
};

/**
 * The panel's real widget chain for a LoRA loader: rule presentation, then the
 * autodiscovery merge, then bypass-target reconciliation.
 */
function buildLoraPanelState(rules: Record<string, unknown> | null) {
  const widgetInputs = mergeAutodiscoveredLoraWidgetInputs(
    rules
      ? resolveWidgetInputs(LORA_WORKFLOW, rules as never, {
          objectInfo: LORA_OBJECT_INFO,
        })
      : [],
    resolveAutodiscoveredLoraWidgetInputs(
      buildGenerationNodeCatalogue(LORA_WORKFLOW, LORA_OBJECT_INFO, null),
    ),
  );
  const { targets } = reconcileNodeBypassWidgetTargets({
    widgetInputs,
    previousTargets: new Set(),
    appliedDefaults: new Set(),
  });
  return { widgetInputs, targets };
}

function renderLoraPanel(rules: Record<string, unknown> | null) {
  const { widgetInputs, targets } = buildLoraPanelState(rules);
  render(
    <GenerationInputs
      inputs={[]}
      textValues={{}}
      onTextValueCommit={vi.fn()}
      mediaInputs={{}}
      onInputDrop={vi.fn()}
      onExternalInputDrop={vi.fn()}
      onInputClear={vi.fn()}
      onSwapMediaInputs={vi.fn()}
      onClickSelect={vi.fn()}
      widgetInputs={[...widgetInputs]}
      widgetValues={{}}
      bypassedWidgetTargets={targets}
      randomizeToggles={{}}
      onWidgetChange={vi.fn()}
      onToggleRandomize={vi.fn()}
    />,
  );
}

describe("GenerationInputs", () => {
  it("shows an autodiscovered loader as a dropdown on its workflow model", () => {
    renderLoraPanel(null);
    expect(screen.getByRole("combobox")).toHaveTextContent("detail.safetensors");
  });

  it("starts a rule-defaulted loader on None, still as a dropdown", () => {
    // A minimal rule entry must not downgrade the enum to a text box showing
    // the raw bypass sentinel.
    renderLoraPanel({
      version: 1,
      nodes: {
        "12": {
          widgets: { lora_name: { label: "Detail LoRA", default_node_bypass: true } },
        },
      },
      slots: {},
    });

    const select = screen.getByRole("combobox");
    expect(select).toHaveTextContent("None (bypass)");
    fireEvent.mouseDown(select);
    expect(
      screen.getByRole("option", { name: "detail.safetensors" }),
    ).toBeInTheDocument();
  });

  it("renders a node-bypass choice through the standard enum widget row", () => {
    const onWidgetChange = vi.fn();
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "4",
            param: "lora_name",
            currentValue: "base.safetensors",
            config: {
              label: "Model",
              controlAfterGenerate: false,
              valueType: "enum",
              options: ["base.safetensors", "detail.safetensors"],
              groupTitle: "Portrait detail",
              nodeBypassOption: {
                value: "native:none",
                label: "None (bypass)",
              },
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={onWidgetChange}
        onToggleRandomize={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "None (bypass)" }));

    expect(onWidgetChange).toHaveBeenCalledWith(
      "4",
      "lora_name",
      "native:none",
    );
  });

  it("shows an out-of-range enum value without replacing it", () => {
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "4",
            param: "lora_name",
            currentValue: "missing.safetensors",
            config: {
              label: "Model",
              controlAfterGenerate: false,
              valueType: "enum",
              options: ["base.safetensors"],
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("combobox"));
    expect(
      screen.getByRole("option", {
        name: "missing.safetensors (unavailable)",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("spawns repeatable media slots as preceding slots fill, up to the sidecar maximum", () => {
    const input = {
      id: "141:images",
      nodeId: "141",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image" as const,
      param: "images",
      label: "Image inputs",
      currentValue: null,
      origin: "rule" as const,
      presentation: { repeatable: { max: 3 } },
    };
    const frameValue = (name: string) => ({
      kind: "frame" as const,
      file: new File([name], name, { type: "image/png" }),
      previewUrl: `blob:${name}`,
      timelineSelection: null,
    });
    const renderPanel = (
      mediaInputs: Record<
        string,
        ReturnType<typeof frameValue> | null
      >,
    ) => (
      <GenerationInputs
        inputs={[input]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={mediaInputs}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />
    );

    const view = render(renderPanel({}));
    expect(document.querySelectorAll("[data-drop-slot-id]")).toHaveLength(1);

    view.rerender(renderPanel({ "141": frameValue("first.png") }));
    expect(document.querySelectorAll("[data-drop-slot-id]")).toHaveLength(2);
    expect(
      document.querySelector(
        '[data-drop-slot-id="141:images::repeat::1"]',
      ),
    ).not.toBeNull();

    view.rerender(
      renderPanel({
        "141:images": frameValue("first.png"),
        "141:images::repeat::1": frameValue("second.png"),
      }),
    );
    expect(document.querySelectorAll("[data-drop-slot-id]")).toHaveLength(3);

    view.rerender(
      renderPanel({
        "141:images": frameValue("first.png"),
        "141:images::repeat::1": frameValue("second.png"),
        "141:images::repeat::2": frameValue("third.png"),
      }),
    );
    expect(document.querySelectorAll("[data-drop-slot-id]")).toHaveLength(3);
  });

  it("keeps the built-in inputs section ahead of explicitly ordered options", () => {
    render(
      <GenerationInputs
        inputs={[
          {
            id: "141:images",
            nodeId: "141",
            classType: "vloMemoryLoadImageBatch",
            inputType: "image",
            param: "images",
            label: "Image inputs",
            currentValue: null,
            origin: "rule",
            presentation: {
              section: { id: "inputs" },
              repeatable: { max: 9 },
            },
          },
        ]}
        sections={[
          {
            id: "references",
            title: "References",
            order: 0,
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "136",
            param: "ref_image_size",
            currentValue: "match",
            config: {
              label: "Reference image size",
              controlAfterGenerate: false,
              valueType: "enum",
              options: ["match", "max"],
              sectionId: "references",
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const imageInputs = screen.getByText("Image inputs");
    const references = screen.getByText("References");
    expect(
      imageInputs.compareDocumentPosition(references) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("buffers prompt edits locally and commits on blur", () => {
    const handleTextValueCommit = vi.fn();

    render(
      <GenerationInputs
        inputs={[
          {
            nodeId: "6",
            classType: "CLIPTextEncode",
            inputType: "text",
            param: "text",
            label: "Prompt",
            currentValue: "",
            origin: "rule",
          },
        ]}
        textValues={{}}
        onTextValueCommit={handleTextValueCommit}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const promptInput = screen.getByPlaceholderText("Enter prompt...");
    fireEvent.change(promptInput, { target: { value: "new draft prompt" } });

    // No commit while typing — state is local to the input
    expect(handleTextValueCommit).not.toHaveBeenCalled();

    fireEvent.blur(promptInput);

    expect(handleTextValueCommit).toHaveBeenCalledWith(
      "6",
      "new draft prompt",
    );
  });

  it("renders string widgets as a committed multiline prompt box", () => {
    const handleWidgetChange = vi.fn();

    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "136",
            param: "prompt",
            currentValue: "existing prompt",
            config: {
              label: "Prompt",
              controlAfterGenerate: false,
              valueType: "string",
              sectionId: "prompt",
              groupId: "prompt",
              groupTitle: "Prompt",
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={handleWidgetChange}
        onToggleRandomize={vi.fn()}
      />,
    );

    const promptInput = screen.getByPlaceholderText("Enter prompt...");
    expect(promptInput.tagName).toBe("TEXTAREA");
    expect(promptInput).toHaveValue("existing prompt");

    fireEvent.change(promptInput, { target: { value: "rewritten prompt" } });
    expect(handleWidgetChange).not.toHaveBeenCalled();

    fireEvent.blur(promptInput);
    expect(handleWidgetChange).toHaveBeenCalledWith(
      "136",
      "prompt",
      "rewritten prompt",
    );
  });

  it("groups sidecar-managed media inputs into one section with sublabels", () => {
    render(
      <GenerationInputs
        inputs={[
          {
            id: "62:image",
            nodeId: "62",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Start frame",
            currentValue: null,
            origin: "rule",
            presentation: {
              group: {
                id: "frames",
                title: "Frames",
                order: 0,
              },
            },
          },
          {
            id: "68:image",
            nodeId: "68",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "End frame",
            currentValue: null,
            origin: "rule",
            presentation: {
              group: {
                id: "frames",
                title: "Frames",
                order: 1,
              },
            },
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{
          "62:image": {
            kind: "frame",
            file: new File(["frame-start"], "start.png", {
              type: "image/png",
            }),
            previewUrl: "blob:start-frame",
            timelineSelection: null,
          },
        }}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Frames")).toHaveLength(1);
    expect(screen.getByText("Start frame")).toBeInTheDocument();
    expect(screen.getByText("End frame")).toBeInTheDocument();
    expect(
      document.querySelector('[data-drop-slot-id="62:image"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-drop-slot-id="68:image"]'),
    ).not.toBeNull();
  });

  it("groups proxy-backed widget controls under a shared section", () => {
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "267:258",
            param: "value",
            currentValue: 720,
            config: {
              label: "Height",
              controlAfterGenerate: true,
              groupId: "267",
              groupTitle: "Video Generation (LTX-2.3)",
              groupOrder: 5,
            },
          },
          {
            nodeId: "267:257",
            param: "value",
            currentValue: 1280,
            config: {
              label: "Width",
              controlAfterGenerate: true,
              groupId: "267",
              groupTitle: "Video Generation (LTX-2.3)",
              groupOrder: 4,
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Settings")).toHaveLength(1);
    expect(screen.getAllByText("Video Generation (LTX-2.3)")).toHaveLength(1);
    expect(screen.getByText("Width")).toBeInTheDocument();
    expect(screen.getByText("Height")).toBeInTheDocument();
  });

  it("renders explicit custom input sections as dedicated panels", () => {
    render(
      <GenerationInputs
        inputs={[
          {
            nodeId: "6",
            classType: "CLIPTextEncode",
            inputType: "text",
            param: "text",
            label: "Prompt",
            currentValue: "",
            origin: "rule",
            presentation: {
              section: {
                id: "guidance",
              },
            },
          },
        ]}
        sections={[
          {
            id: "guidance",
            title: "Guidance",
            order: 0,
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Guidance")).toBeInTheDocument();
    expect(screen.getByText("Prompt")).toBeInTheDocument();
  });

  it("moves widget controls from Settings into a dedicated section", () => {
    render(
      <GenerationInputs
        inputs={[]}
        sections={[
          {
            id: "masking",
            title: "Masking",
            order: 1,
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "mask-node",
            param: "crop_mode",
            currentValue: "crop",
            config: {
              label: "Mask crop mode",
              controlAfterGenerate: false,
              valueType: "enum",
              options: ["crop", "full"],
              sectionId: "masking",
            },
          },
          {
            nodeId: "seed-node",
            param: "seed",
            currentValue: 42,
            config: {
              label: "Seed",
              controlAfterGenerate: false,
              valueType: "int",
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const maskingTitle = screen.getByText("Masking");
    const settingsTitle = screen.getByText("Settings");

    expect(
      maskingTitle.compareDocumentPosition(settingsTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getAllByText("Mask crop mode")).toHaveLength(2);
    expect(screen.getAllByText("Seed")).toHaveLength(2);
  });

  it("renders media inputs before text prompts by default", () => {
    render(
      <GenerationInputs
        inputs={[
          {
            nodeId: "6",
            classType: "CLIPTextEncode",
            inputType: "text",
            param: "text",
            label: "Prompt",
            currentValue: "",
            origin: "rule",
          },
          {
            nodeId: "12",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Reference image",
            currentValue: null,
            origin: "rule",
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const mediaTitle = screen.getByText("Reference image");
    const promptTitle = screen.getByText("Prompt");

    expect(
      mediaTitle.compareDocumentPosition(promptTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("renders derived denoise widgets as sliders", () => {
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            kind: "derived",
            deriveKind: "dual_sampler_denoise",
            derivedWidgetId: "denoise",
            nodeId: "derived:denoise",
            param: "__value",
            currentValue: 0.8,
            sources: {
              totalSteps: 10,
              startStep: 2,
              baseSplitStep: 4,
            },
            config: {
              label: "Denoise",
              control: "slider",
              controlAfterGenerate: false,
              frontendOnly: true,
              min: 0.1,
              max: 1,
              step: 0.1,
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getAllByText("Denoise")).toHaveLength(2);
    const slider = screen.getByRole("slider", { name: "Denoise" });
    const sliderRoot = slider.closest(".MuiSlider-root");
    const sliderInset = sliderRoot?.parentElement;

    expect(sliderRoot).toHaveClass("MuiSlider-sizeSmall");
    expect(sliderInset).toHaveStyle({
      paddingLeft: "8px",
      paddingRight: "8px",
    });
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("renders numeric slider widgets using their unit instead of percent", () => {
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "291",
            param: "value",
            currentValue: 10,
            config: {
              label: "Duration",
              control: "slider",
              controlAfterGenerate: false,
              min: 1 / 3,
              max: 20,
              step: 1 / 3,
              sliderDisplay: "number",
              unit: "s",
              valueType: "float",
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Duration")).toHaveLength(2);
    expect(screen.getByRole("slider")).toBeInTheDocument();
    expect(screen.getByText("10 s")).toBeInTheDocument();
  });

  it("renders the exact aspect ratio toggle beside the aspect ratio widget", () => {
    const handleExactAspectRatioChange = vi.fn();

    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            nodeId: "12",
            param: "aspect_ratio",
            currentValue: "16:9",
            config: {
              label: "Aspect Ratio",
              controlAfterGenerate: false,
              valueType: "enum",
              options: ["16:9", "4:3"],
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
        showExactAspectRatioControl={true}
        exactAspectRatio={false}
        onExactAspectRatioChange={handleExactAspectRatioChange}
        exactAspectRatioTooltip="Tooltip"
      />,
    );

    fireEvent.click(screen.getByLabelText("Use exact input aspect ratio"));

    expect(handleExactAspectRatioChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("EXACT")).toBeInTheDocument();
  });

  it("can target the exact aspect ratio toggle at a non-aspect-ratio widget", () => {
    const handleExactAspectRatioChange = vi.fn();

    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[
          {
            kind: "raw",
            nodeId: "__pipeline__:aspect_ratio",
            param: "target_resolution",
            currentValue: 720,
            config: {
              label: "Resolution",
              description:
                "Generation resolution controls the short edge before strided resize.",
              controlAfterGenerate: false,
              frontendOnly: true,
              valueType: "enum",
              options: [480, 720],
            },
          },
        ]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
        showExactAspectRatioControl={true}
        exactAspectRatioWidgetKey="__pipeline__:aspect_ratio:target_resolution"
        exactAspectRatio={false}
        onExactAspectRatioChange={handleExactAspectRatioChange}
        exactAspectRatioTooltip="Tooltip"
      />,
    );

    fireEvent.click(screen.getByLabelText("Use exact input aspect ratio"));

    expect(handleExactAspectRatioChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByText(
        "Generation resolution controls the short edge before strided resize.",
      ),
    ).toBeInTheDocument();
  });

  it("forwards compatible external file drops to the media input handler", () => {
    const handleExternalInputDrop = vi.fn();

    render(
      <GenerationInputs
        inputs={[
          {
            id: "image-input",
            nodeId: "10",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Image",
            currentValue: null,
            origin: "rule",
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={handleExternalInputDrop}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const slot = document.querySelector(
      '[data-drop-slot-id="image-input"]',
    ) as HTMLElement | null;
    expect(slot).not.toBeNull();

    const file = new File(["image-bytes"], "reference.png", {
      type: "image/png",
    });

    fireEvent.drop(slot!, {
      dataTransfer: {
        files: [file],
        types: ["Files"],
      },
    });

    expect(handleExternalInputDrop).toHaveBeenCalledWith("image-input", file);
  });

  it("forwards video drops on image inputs for frame extraction", () => {
    const handleExternalInputDrop = vi.fn();

    render(
      <GenerationInputs
        inputs={[
          {
            id: "image-input",
            nodeId: "10",
            classType: "LoadImage",
            inputType: "image",
            param: "image",
            label: "Image",
            currentValue: null,
            origin: "rule",
          },
        ]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={handleExternalInputDrop}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const slot = document.querySelector(
      '[data-drop-slot-id="image-input"]',
    ) as HTMLElement | null;
    expect(slot).not.toBeNull();

    const file = new File(["video-bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    fireEvent.drop(slot!, {
      dataTransfer: {
        files: [file],
        types: ["Files"],
      },
    });

    expect(handleExternalInputDrop).toHaveBeenCalledWith("image-input", file);
  });
  it("shows a video filling an audio slot as extracting, then as audio", () => {
    const audioInput = {
      id: "audio-input",
      nodeId: "20",
      classType: "LoadAudio",
      inputType: "audio" as const,
      param: "audio",
      label: "Audio",
      currentValue: null,
      origin: "rule" as const,
    };
    const videoAsset = {
      id: "asset-video",
      hash: "hash",
      name: "clip.mp4",
      type: "video",
      src: "assets/clip.mp4",
      thumbnail: "blob:thumb",
      hasAudio: true,
      createdAt: 0,
    };

    const renderWithValue = (value: unknown) =>
      render(
        <GenerationInputs
          inputs={[audioInput]}
          textValues={{}}
          onTextValueCommit={vi.fn()}
          mediaInputs={{ "audio-input": value as never }}
          onInputDrop={vi.fn()}
          onExternalInputDrop={vi.fn()}
          onInputClear={vi.fn()}
          onSwapMediaInputs={vi.fn()}
          onClickSelect={vi.fn()}
          widgetInputs={[]}
          widgetValues={{}}
          randomizeToggles={{}}
          onWidgetChange={vi.fn()}
          onToggleRandomize={vi.fn()}
        />,
      );

    const extracting = renderWithValue({
      kind: "asset",
      asset: videoAsset,
      isExtracting: true,
      extractionRequestId: 1,
      extractedAudioFile: null,
      extractionError: null,
    });
    expect(screen.getByText("Extracting audio…")).toBeInTheDocument();
    // The video thumbnail must not stand in for a slot that is still working.
    expect(document.querySelector('img[src="blob:thumb"]')).toBeNull();
    extracting.unmount();

    const ready = renderWithValue({
      kind: "asset",
      asset: videoAsset,
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: new File(["wav"], "audio.wav", {
        type: "audio/wav",
      }),
      extractionError: null,
    });
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(document.querySelector('img[src="blob:thumb"]')).toBeNull();
    ready.unmount();

    renderWithValue({
      kind: "asset",
      asset: videoAsset,
      isExtracting: false,
      extractionRequestId: 1,
      extractedAudioFile: null,
      extractionError: "No audio track was found in this video",
    });
    expect(
      screen.getByText("No audio track was found in this video"),
    ).toBeInTheDocument();
  });
  it("takes an external video file on audio and image slots", () => {
    const handleExternalInputDrop = vi.fn();
    const audioInput = {
      id: "audio-input",
      nodeId: "20",
      classType: "LoadAudio",
      inputType: "audio" as const,
      param: "audio",
      label: "Audio",
      currentValue: null,
      origin: "rule" as const,
    };
    const imageInput = {
      id: "image-input",
      nodeId: "10",
      classType: "LoadImage",
      inputType: "image" as const,
      param: "image",
      label: "Image",
      currentValue: null,
      origin: "rule" as const,
    };

    render(
      <GenerationInputs
        inputs={[audioInput, imageInput]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={handleExternalInputDrop}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />,
    );

    const videoFile = new File(["video-bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    fireEvent.drop(
      document.querySelector('[data-drop-slot-id="audio-input"]')!,
      { dataTransfer: { files: [videoFile], types: ["Files"] } },
    );
    expect(handleExternalInputDrop).toHaveBeenCalledWith(
      "audio-input",
      videoFile,
    );

    // Image slots route video drops through frame extraction.
    handleExternalInputDrop.mockClear();
    fireEvent.drop(
      document.querySelector('[data-drop-slot-id="image-input"]')!,
      { dataTransfer: { files: [videoFile], types: ["Files"] } },
    );
    expect(handleExternalInputDrop).toHaveBeenCalledWith(
      "image-input",
      videoFile,
    );
  });
});
