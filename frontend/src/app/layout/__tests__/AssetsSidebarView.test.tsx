import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editorOpen: false,
  assetBrowserProps: null as { previewPresentation?: string } | null,
}));

vi.mock("../../../features/userAssets", () => ({
  AssetBrowser: (props: { previewPresentation?: string }) => {
    mocks.assetBrowserProps = props;
    return <div data-testid="asset-browser" />;
  },
}));

vi.mock("../../../features/generation", () => ({
  useGenerationStore: (
    selector: (state: { editorOpen: boolean }) => unknown,
  ) => selector({ editorOpen: mocks.editorOpen }),
}));

import { AssetsSidebarView } from "../AssetsSidebarView";

describe("AssetsSidebarView", () => {
  beforeEach(() => {
    mocks.editorOpen = false;
    mocks.assetBrowserProps = null;
  });

  it("keeps the production asset preview on the modal presentation", () => {
    render(<AssetsSidebarView />);

    expect(screen.getByTestId("asset-browser")).toBeInTheDocument();
    expect(mocks.assetBrowserProps?.previewPresentation).toBeUndefined();
  });

  it("suppresses the sidebar browser while the generation editor owns it", () => {
    mocks.editorOpen = true;
    render(<AssetsSidebarView />);

    expect(screen.queryByTestId("asset-browser")).not.toBeInTheDocument();
    expect(mocks.assetBrowserProps).toBeNull();
  });
});
