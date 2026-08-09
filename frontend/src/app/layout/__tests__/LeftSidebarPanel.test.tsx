import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeftSidebarPanel } from "../LeftSidebarPanel";

const views = ["assets", "text", "composite"].map((id, order) => ({
  id: `host.${id}`,
  title: id[0].toUpperCase() + id.slice(1),
  defaultRegion: "left-sidebar" as const,
  allowedRegions: ["left-sidebar"] as const,
  order,
  keepMounted: false,
  eager: false,
  source: "host" as const,
  component: () => null,
}));

describe("LeftSidebarPanel", () => {
  it("renders the assets tab as the active input source", () => {
    const handleTabChange = vi.fn();

    render(
      <LeftSidebarPanel
        activeTab="host.assets"
        onTabChange={handleTabChange}
        views={views}
      />,
    );

    expect(screen.getByTestId("left-sidebar-tab-assets")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Assets" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Text" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Composite" })).toBeInTheDocument();
  });

  it("switches to the text tab when clicked", () => {
    const handleTabChange = vi.fn();

    render(
      <LeftSidebarPanel
        activeTab="host.assets"
        onTabChange={handleTabChange}
        views={views}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Text" }));

    expect(handleTabChange).toHaveBeenCalledWith("host.text");
  });

  it("switches to the composite tab when clicked", () => {
    const handleTabChange = vi.fn();

    render(
      <LeftSidebarPanel
        activeTab="host.assets"
        onTabChange={handleTabChange}
        views={views}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Composite" }));

    expect(handleTabChange).toHaveBeenCalledWith("host.composite");
  });
});
