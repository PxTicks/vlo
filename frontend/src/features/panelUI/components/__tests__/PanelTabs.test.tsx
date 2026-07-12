import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanelTabs } from "../PanelTabs";

function Fixture() {
  const [value, setValue] = useState<"display" | "audio">("display");
  return (
    <PanelTabs
      ariaLabel="Inspector categories"
      tabs={[
        { value: "display", label: "Display" },
        { value: "audio", label: "Audio" },
      ]}
      value={value}
      onChange={setValue}
    >
      {value === "display" ? "Display controls" : "Audio controls"}
    </PanelTabs>
  );
}

describe("PanelTabs", () => {
  it("associates tabs with the active panel and changes content", () => {
    render(<Fixture />);

    const displayTab = screen.getByRole("tab", { name: "Display" });
    expect(displayTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Display" })).toHaveTextContent(
      "Display controls",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
    expect(screen.getByRole("tabpanel", { name: "Audio" })).toHaveTextContent(
      "Audio controls",
    );
  });
});
