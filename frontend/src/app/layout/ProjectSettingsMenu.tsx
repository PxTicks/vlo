import { useState } from "react";
import {
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import ViewSidebarIcon from "@mui/icons-material/ViewSidebar";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import CheckIcon from "@mui/icons-material/Check";
import type {
  AspectRatio,
  AssetBrowserDisplay,
  ProjectFitMode,
} from "../../features/project";
import { useProjectStore } from "../../features/project/useProjectStore";

const FPS_OPTIONS = [16, 24, 25, 30, 60];

const FIT_MODE_OPTIONS: Array<{ value: ProjectFitMode; label: string }> = [
  { value: "contain", label: "Contain (Letterbox)" },
  { value: "cover", label: "Cover (Fill & Crop)" },
];

const ASPECT_RATIO_OPTIONS: Array<{ value: AspectRatio; label: string }> = [
  { value: "16:9", label: "16:9 (Landscape)" },
  { value: "4:3", label: "4:3 (Standard)" },
  { value: "1:1", label: "1:1 (Square)" },
  { value: "3:4", label: "3:4 (Portrait)" },
  { value: "9:16", label: "9:16 (Story)" },
];

export function ProjectSettingsMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const config = useProjectStore((state) => state.config);
  const updateConfig = useProjectStore((state) => state.updateConfig);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleLayoutChange = (mode: "full-height" | "compact") => {
    void updateConfig({ layoutMode: mode });
    handleClose();
  };

  const handleFpsChange = (fps: number) => {
    void updateConfig({ fps });
    handleClose();
  };

  const handleAspectRatioChange = (aspectRatio: AspectRatio) => {
    void updateConfig({ aspectRatio });
    handleClose();
  };
  const handleFitModeChange = (fitMode: ProjectFitMode) => {
    void updateConfig({ fitMode });
    handleClose();
  };

  const handleAssetBrowserDisplayChange = (display: AssetBrowserDisplay) => {
    void updateConfig({ assetBrowserDisplay: display });
    handleClose();
  };
  const currentFitMode = config.fitMode || "contain";
  const currentLayout = config.layoutMode || "compact";
  const currentFps = config.fps || 30;
  const currentAspectRatio = config.aspectRatio || "16:9";
  const currentAssetBrowserDisplay = config.assetBrowserDisplay || "grouped";

  return (
    <>
      <IconButton
        onClick={handleClick}
        size="small"
        sx={{ ml: 1, color: "rgba(255, 255, 255, 0.7)" }}
        data-testid="project-settings-button"
        aria-label="Project Settings"
      >
        <SettingsIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: {
              bgcolor: "#1e1e1e",
              color: "white",
              border: "1px solid #333",
              minWidth: 200,
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="gray">
            LAYOUT
          </Typography>
        </Box>
        <MenuItem onClick={() => handleLayoutChange("full-height")}>
          <ListItemIcon>
            <ViewSidebarIcon
              fontSize="small"
              sx={{
                color:
                  currentLayout === "full-height" ? "primary.main" : "white",
              }}
            />
          </ListItemIcon>
          <ListItemText>Full Height Sidebars</ListItemText>
          {currentLayout === "full-height" && (
            <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
          )}
        </MenuItem>
        <MenuItem onClick={() => handleLayoutChange("compact")}>
          <ListItemIcon>
            <ViewStreamIcon
              fontSize="small"
              sx={{
                color: currentLayout === "compact" ? "primary.main" : "white",
              }}
            />
          </ListItemIcon>
          <ListItemText>Classic (Wide Timeline)</ListItemText>
          {currentLayout === "compact" && (
            <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
          )}
        </MenuItem>

        <Divider sx={{ borderColor: "#333" }} />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="gray">
            FPS
          </Typography>
        </Box>
        {FPS_OPTIONS.map((fps) => (
          <MenuItem key={fps} onClick={() => handleFpsChange(fps)}>
            <ListItemText>{`${fps} fps`}</ListItemText>
            {currentFps === fps && (
              <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
            )}
          </MenuItem>
        ))}

        <Divider sx={{ borderColor: "#333" }} />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="gray">
            ASPECT RATIO
          </Typography>
        </Box>
        {ASPECT_RATIO_OPTIONS.map((ratio) => (
          <MenuItem
            key={ratio.value}
            onClick={() => handleAspectRatioChange(ratio.value)}
          >
            <ListItemText>{ratio.label}</ListItemText>
            {currentAspectRatio === ratio.value && (
              <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
            )}
          </MenuItem>
        ))}

        <Divider sx={{ borderColor: "#333" }} />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="gray">
            FIT MODE
          </Typography>
        </Box>
        {FIT_MODE_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            onClick={() => handleFitModeChange(option.value)}
          >
            <ListItemText>{option.label}</ListItemText>
            {currentFitMode === option.value && (
              <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
            )}
          </MenuItem>
        ))}

        <Divider sx={{ borderColor: "#333" }} />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="gray">
            ASSET BROWSER
          </Typography>
        </Box>
        <MenuItem onClick={() => handleAssetBrowserDisplayChange("grouped")}>
          <ListItemText>Grouped assets</ListItemText>
          {currentAssetBrowserDisplay === "grouped" && (
            <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
          )}
        </MenuItem>
        <MenuItem onClick={() => handleAssetBrowserDisplayChange("ungrouped")}>
          <ListItemText>Ungrouped assets</ListItemText>
          {currentAssetBrowserDisplay === "ungrouped" && (
            <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
          )}
        </MenuItem>
      </Menu>
    </>
  );
}
