import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GenerationInputs } from "../GenerationInputs";

describe("GenerationInputs", () => {
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
    expect(screen.getByRole("slider")).toBeInTheDocument();
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

  it("ignores incompatible external file drops", () => {
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

    expect(handleExternalInputDrop).not.toHaveBeenCalled();
  });
});
