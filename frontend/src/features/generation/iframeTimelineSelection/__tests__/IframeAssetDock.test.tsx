// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composites: [] as Array<{
    id: string;
    name: string;
    bakedAssetId?: string;
  }>,
  assets: [] as Array<{
    id: string;
    name: string;
  }>,
  temporaryAssets: [] as Array<{
    asset: { id: string; name: string };
  }>,
}));

vi.mock("../../../composite", () => ({
  useCompositeLibraryStore: (selector: (state: unknown) => unknown) =>
    selector({ composites: mocks.composites }),
}));

vi.mock("../../../userAssets", () => ({
  AssetBrowser: () => <div data-testid="asset-browser">Assets</div>,
  AssetCard: ({ asset }: { asset: { name: string } }) => (
    <div data-testid="asset-card">{asset.name}</div>
  ),
  AssetPreviewDialog: () => null,
  useAssetStore: (selector: (state: unknown) => unknown) =>
    selector({ assets: mocks.assets }),
}));

vi.mock("../../../libraryBrowser", () => ({
  LibraryBrowserGrid: ({
    items,
    renderItem,
    emptyMessage,
  }: {
    items: unknown[];
    renderItem: (item: unknown) => ReactNode;
    emptyMessage: string;
  }) => (
    <div>
      {items.length === 0
        ? emptyMessage
        : items.map((item, index) => <div key={index}>{renderItem(item)}</div>)}
    </div>
  ),
}));

vi.mock("../useIframeTimelineSelectionStore", () => ({
  useIframeTimelineSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({ assets: mocks.temporaryAssets }),
}));

import {
  IframeAssetDock,
  type IframeAssetDockTab,
} from "../IframeAssetDock";

function Harness() {
  const [tab, setTab] = useState<IframeAssetDockTab>("assets");
  return <IframeAssetDock activeTab={tab} onTabChange={setTab} />;
}

describe("IframeAssetDock", () => {
  beforeEach(() => {
    mocks.composites = [];
    mocks.assets = [];
    mocks.temporaryAssets = [];
  });

  it("always exposes project and temporary assets but hides an empty composite tab", () => {
    render(<Harness />);

    expect(screen.getByTestId("comfyui-dock-tab-assets")).toBeInTheDocument();
    expect(
      screen.getByTestId("comfyui-dock-tab-temporary"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("comfyui-dock-tab-composites"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("comfyui-dock-tab-temporary"));
    expect(screen.getByTestId("comfyui-temporary-library")).toBeInTheDocument();
  });

  it("shows existing composite clips without creation controls", () => {
    mocks.composites = [
      { id: "composite-1", name: "Opening", bakedAssetId: "baked-1" },
    ];
    mocks.assets = [{ id: "baked-1", name: "baked.mp4" }];
    render(<Harness />);

    fireEvent.click(screen.getByTestId("comfyui-dock-tab-composites"));

    expect(screen.getByTestId("comfyui-composite-library")).toBeInTheDocument();
    expect(screen.getByText("Opening")).toBeInTheDocument();
    expect(
      screen.queryByText(/from selection|add blank/i),
    ).not.toBeInTheDocument();
  });
});
