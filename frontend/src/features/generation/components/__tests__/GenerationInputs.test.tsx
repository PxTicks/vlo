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
        onInputClear={vi.fn()}
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

  it("groups proxy-backed widget controls under a shared section", () => {
    render(
      <GenerationInputs
        inputs={[]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onInputClear={vi.fn()}
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

    expect(screen.getAllByText("Video Generation (LTX-2.3)")).toHaveLength(1);
    expect(screen.getByText("Width")).toBeInTheDocument();
    expect(screen.getByText("Height")).toBeInTheDocument();
  });
});
