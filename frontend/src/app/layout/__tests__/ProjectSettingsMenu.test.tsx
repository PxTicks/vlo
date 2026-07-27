import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsMenu } from "../ProjectSettingsMenu";
import { useProjectStore } from "../../../features/project";

describe("ProjectSettingsMenu", () => {
  beforeEach(() => {
    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
        fps: 30,
        fitMode: "cover",
        layoutMode: "compact",
        assetBrowserDisplay: "grouped",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render generation resolution controls", () => {
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.queryByText("RESOLUTION")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resolution")).not.toBeInTheDocument();
  });

  it("offers grouped and ungrouped asset browser display options", () => {
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("ASSET BROWSER")).toBeInTheDocument();
    expect(screen.getByText("Grouped assets")).toBeInTheDocument();
    expect(screen.getByText("Ungrouped assets")).toBeInTheDocument();
  });

  // App-scoped settings moved to the landing page's AppSettingsMenu; the
  // editor menu must stay project-scoped so the two surfaces cannot drift back
  // into overlapping.
  it("no longer offers install-wide settings", () => {
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.queryByText("EXTENSIONS")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage extensions")).not.toBeInTheDocument();
    expect(screen.queryByText("RUNTIME")).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime settings")).not.toBeInTheDocument();
  });
});
