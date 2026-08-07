import { useMemo } from "react";
import { Box, Tab, Tabs, Typography } from "@mui/material";
import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";
import LayersIcon from "@mui/icons-material/Layers";
import HourglassBottomIcon from "@mui/icons-material/HourglassBottom";
import type { Asset } from "../../../types/Asset";
import { LibraryBrowserGrid } from "../../libraryBrowser";
import { useCompositeLibraryStore } from "../../composite";
import {
  AssetBrowser,
  AssetCard,
  openAssetInMiniEditor,
  useAssetStore,
} from "../../userAssets";
import { useIframeTimelineSelectionStore } from "./useIframeTimelineSelectionStore";

export type IframeAssetDockTab = "assets" | "composites" | "temporary";

interface IframeAssetDockProps {
  activeTab: IframeAssetDockTab;
  onTabChange: (tab: IframeAssetDockTab) => void;
}

const TAB_SX = {
  minWidth: 40,
  minHeight: 40,
  width: 40,
  borderRadius: 2,
  color: "#9aa0a6",
  mx: 1,
  my: 0.5,
  "&.Mui-selected": {
    color: "#4dabf5",
    bgcolor: "rgba(77, 171, 245, 0.12)",
  },
} as const;

function DockPanelHeader({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      sx={{
        px: 2,
        py: 1.75,
        color: "#c9d1d9",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}
    >
      {children}
    </Typography>
  );
}

function IframeCompositeLibrary({
  onPreview,
}: {
  onPreview: (asset: Asset) => void;
}) {
  const composites = useCompositeLibraryStore((state) => state.composites);
  const assets = useAssetStore((state) => state.assets);
  const bakedAssets = useMemo(() => {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    return composites.flatMap((composite) => {
      const asset = composite.bakedAssetId
        ? assetById.get(composite.bakedAssetId)
        : undefined;
      return asset ? [{ ...asset, name: composite.name }] : [];
    });
  }, [assets, composites]);

  return (
    <Box
      data-testid="comfyui-composite-library"
      sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      <DockPanelHeader>Composite clips</DockPanelHeader>
      <LibraryBrowserGrid
        items={bakedAssets}
        getItemId={(asset) => asset.id}
        emptyMessage="No rendered composite clips are available."
        renderItem={(asset) => (
          <AssetCard
            asset={asset}
            hideActions
            onRequestPreview={() => onPreview(asset)}
          />
        )}
      />
    </Box>
  );
}

function IframeTemporaryLibrary({
  onPreview,
}: {
  onPreview: (asset: Asset) => void;
}) {
  const entries = useIframeTimelineSelectionStore((state) => state.assets);

  return (
    <Box
      data-testid="comfyui-temporary-library"
      sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      <DockPanelHeader>Temporary selections</DockPanelHeader>
      <LibraryBrowserGrid
        items={entries}
        getItemId={(entry) => entry.asset.id}
        emptyMessage="Timeline selections made here appear for this project session."
        renderItem={(entry) => (
          <AssetCard
            asset={entry.asset}
            hideActions
            onRequestPreview={() => onPreview(entry.asset)}
          />
        )}
      />
    </Box>
  );
}

export function IframeAssetDock({
  activeTab,
  onTabChange,
}: IframeAssetDockProps) {
  const hasComposites = useCompositeLibraryStore(
    (state) => state.composites.length > 0,
  );
  const visibleTab =
    activeTab === "composites" && !hasComposites ? "assets" : activeTab;
  const handlePreview = (asset: Asset) => {
    void openAssetInMiniEditor(asset, {
      openerId: "iframe-asset-dock",
    });
  };

  return (
    <Box sx={{ display: "flex", minWidth: 0, minHeight: 0, flex: 1 }}>
      <Box
        sx={{
          width: 56,
          flexShrink: 0,
          borderRight: "1px solid #333",
          bgcolor: "#0d0d0d",
          display: "flex",
          justifyContent: "center",
          py: 1,
        }}
      >
        <Tabs
          orientation="vertical"
          value={visibleTab}
          onChange={(_, value: IframeAssetDockTab) => onTabChange(value)}
          aria-label="ComfyUI input sources"
          sx={{
            minHeight: 0,
            "& .MuiTabs-indicator": { left: 0, width: 3 },
          }}
        >
          <Tab
            value="assets"
            icon={<VideoLibraryIcon fontSize="small" />}
            aria-label="Assets"
            data-testid="comfyui-dock-tab-assets"
            sx={TAB_SX}
          />
          {hasComposites ? (
            <Tab
              value="composites"
              icon={<LayersIcon fontSize="small" />}
              aria-label="Composite clips"
              data-testid="comfyui-dock-tab-composites"
              sx={TAB_SX}
            />
          ) : null}
          <Tab
            value="temporary"
            icon={<HourglassBottomIcon fontSize="small" />}
            aria-label="Temporary selections"
            data-testid="comfyui-dock-tab-temporary"
            sx={TAB_SX}
          />
        </Tabs>
      </Box>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          flex: 1,
        }}
      >
        {visibleTab === "assets" ? <AssetBrowser /> : null}
        {visibleTab === "composites" ? (
          <IframeCompositeLibrary onPreview={handlePreview} />
        ) : null}
        {visibleTab === "temporary" ? (
          <IframeTemporaryLibrary onPreview={handlePreview} />
        ) : null}
      </Box>
    </Box>
  );
}
