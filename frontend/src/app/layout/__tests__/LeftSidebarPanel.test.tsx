import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeftSidebarPanel } from "../LeftSidebarPanel";

describe("LeftSidebarPanel", () => {
  it("renders the assets tab as the active input source", () => {
    const handleTabChange = vi.fn();

    render(
      <LeftSidebarPanel activeTab="assets" onTabChange={handleTabChange} />,
    );

    expect(screen.getByTestId("left-sidebar-tab-assets")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Assets" })).toBeInTheDocument();
  });
});
