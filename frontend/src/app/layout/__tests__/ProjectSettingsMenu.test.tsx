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

  it("opens extension management from the settings menu", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ extensions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ProjectSettingsMenu />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("EXTENSIONS")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Manage extensions"));

    expect(
      await screen.findByRole("heading", { name: "Extension manager" }),
    ).toBeInTheDocument();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/app/extensions");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
