import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsMenu } from "../ProjectSettingsMenu";
import { useProjectStore } from "../../../features/project";

describe("ProjectSettingsMenu", () => {
  beforeEach(() => {
    useProjectStore.setState({
      config: {
        aspectRatio: "16:9",
        outputResolution: 1080,
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

  // The project's own output resolution lives here; generation's target
  // resolution does not, and belongs to the generation panel. The two are
  // different settings and the menu must not blur them.
  it("offers the project output resolution", () => {
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("OUTPUT RESOLUTION")).toBeInTheDocument();
    for (const label of ["480p (SD)", "720p (HD)", "1080p (FHD)", "4K (UHD)"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("does not render generation resolution controls", () => {
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.queryByText("RESOLUTION")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resolution")).not.toBeInTheDocument();
  });

  it("marks the project's current output resolution as selected", () => {
    useProjectStore.setState({
      config: { ...useProjectStore.getState().config, outputResolution: 720 },
    });
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    // The menu marks the active option with a check icon, as the aspect-ratio
    // and fps groups do.
    const menuItemFor = (label: string) => {
      const item = screen.getByText(label).closest('[role="menuitem"]');
      expect(item).not.toBeNull();
      return item as HTMLElement;
    };

    expect(
      within(menuItemFor("720p (HD)")).getByTestId("CheckIcon"),
    ).toBeInTheDocument();
    expect(
      within(menuItemFor("1080p (FHD)")).queryByTestId("CheckIcon"),
    ).not.toBeInTheDocument();
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
