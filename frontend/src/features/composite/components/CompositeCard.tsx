import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  Box,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import AddToTimelineIcon from "@mui/icons-material/PlaylistAdd";
import LayersIcon from "@mui/icons-material/Layers";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsIcon from "@mui/icons-material/Sensors";
import { styled } from "@mui/material/styles";
import type { CompositeAsset } from "../../../types/TimelineTypes";
import { useAsset } from "../../userAssets/api";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import { createCompositeBaseClipFromAsset } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";
import {
  setCompositeForceLive,
  useCompositeBakeRuntimeStatus,
  useIsCompositeForceLive,
} from "../useCompositeRenderStatusStore";
import { AppMenu } from "../../../core/shell/AppMenu";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";

interface CompositeCardProps {
  composite: CompositeAsset;
  isSelected: boolean;
  disableDrag?: boolean;
  onSelect: (event: MouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onPlaceOnTimeline: () => void;
}

const CardRoot = styled(Paper)({
  position: "relative",
  width: "100%",
  overflow: "hidden",
  backgroundColor: "#252525",
  color: "white",
  cursor: "grab",
  transition: "transform 0.1s, box-shadow 0.1s, outline-color 0.1s",
  "&:hover": {
    transform: "scale(1.02)",
  },
});

const PreviewArea = styled("div")({
  height: 80,
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#000",
});

const CardActionButton = styled(IconButton)({
  position: "absolute",
  top: 4,
  padding: 4,
  zIndex: 10,
  color: "white",
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  "&:hover": {
    backgroundColor: "rgba(0, 0, 0, 0.75)",
  },
});

function CompositeCardComponent({
  composite,
  isSelected,
  disableDrag = false,
  onSelect,
  onOpen,
  onRename,
  onDelete,
  onPlaceOnTimeline,
}: CompositeCardProps) {
  const bakedAsset = useAsset(composite.bake?.assetId ?? composite.bakedAssetId);
  const retryCompositeBake = useCompositeLibraryStore(
    (state) => state.retryCompositeBake,
  );
  const runtimeBake = useCompositeBakeRuntimeStatus(composite.id);
  const forceLive = useIsCompositeForceLive(composite.id);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const menuSubject = useMemo<HostMenuSubject<"library.composite.actions">>(
    () => ({
      slot: "library.composite.actions",
      composite: {
        id: composite.id,
        name: composite.name,
        durationTicks: composite.content.durationTicks,
        bakeStatus: composite.bake?.status ?? "live_only",
      },
    }),
    [
      composite.bake?.status,
      composite.content.durationTicks,
      composite.id,
      composite.name,
    ],
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `composite-asset-${composite.id}`,
    data: {
      type: "asset",
      clip: createCompositeBaseClipFromAsset(composite),
      compositeAsset: composite,
    },
    disabled: disableDrag,
  });

  const stopAction = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleOpenMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopAction(event);
      setMenuAnchorEl(event.currentTarget);
    },
    [stopAction],
  );

  const handleCloseMenu = useCallback(() => {
    setMenuAnchorEl(null);
  }, []);

  const menuItems: HostMenuItemDescriptor[] = [
    {
      kind: "action",
      id: "edit",
      label: "Edit composite",
      icon: <EditIcon fontSize="small" />,
      group: "1_composite",
      run: onOpen,
    },
    {
      kind: "action",
      id: "place-on-timeline",
      label: "Place on timeline",
      icon: <AddToTimelineIcon fontSize="small" />,
      group: "1_composite",
      run: onPlaceOnTimeline,
    },
    {
      kind: "action",
      id: "rename",
      label: "Rename",
      icon: <DriveFileRenameOutlineIcon fontSize="small" />,
      group: "1_composite",
      run: onRename,
    },
    ...(composite.bake?.status === "failed"
      ? [
          {
            kind: "action",
            id: "retry-bake",
            label: "Retry background bake",
            icon: <RefreshIcon fontSize="small" />,
            group: "1_composite",
            run: () => {
              void retryCompositeBake(composite.id);
            },
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    {
      kind: "action",
      id: "delete",
      label: "Delete",
      icon: <DeleteOutlineIcon fontSize="small" color="error" />,
      group: "1_composite",
      run: onDelete,
    },
  ];

  return (
    <>
      <CardRoot
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        elevation={2}
        data-testid="composite-card"
        data-composite-id={composite.id}
        data-selected={isSelected ? "true" : "false"}
        onClick={onSelect}
        style={{
          opacity: isDragging ? 0.55 : 1,
          outline: isSelected ? "2px solid #4dabf5" : "2px solid transparent",
          outlineOffset: "-2px",
          boxShadow: isSelected
            ? "0 0 0 1px rgba(77, 171, 245, 0.35)"
            : "none",
          cursor: disableDrag ? "pointer" : "grab",
        }}
      >
        <PreviewArea>
          {bakedAsset?.thumbnail || bakedAsset?.src ? (
            <img
              src={bakedAsset.thumbnail || bakedAsset.src}
              alt={composite.name}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <LayersIcon sx={{ fontSize: 40, color: "#888" }} />
          )}
        </PreviewArea>

        <Tooltip
          title={forceLive ? "Use automatic source policy" : "Force live rendering"}
        >
          <CardActionButton
            size="small"
            aria-label={
              forceLive ? "Use automatic source policy" : "Force live rendering"
            }
            aria-pressed={forceLive}
            onMouseDown={stopAction}
            onClick={(event) => {
              stopAction(event);
              setCompositeForceLive(composite.id, !forceLive);
            }}
            sx={{ left: 4, color: forceLive ? "#86efac" : "white" }}
          >
            <SensorsIcon fontSize="small" />
          </CardActionButton>
        </Tooltip>

        <CardActionButton
          size="small"
          aria-label="Composite actions"
          title="Composite actions"
          aria-haspopup="menu"
          aria-expanded={menuAnchorEl ? "true" : undefined}
          onMouseDown={stopAction}
          onClick={handleOpenMenu}
          sx={{ right: 4 }}
        >
          <MoreVertIcon fontSize="small" />
        </CardActionButton>

        <Box sx={{ p: 1 }}>
          <Typography
            variant="caption"
            noWrap
            display="block"
            sx={{ fontWeight: 500 }}
            title={composite.name}
            data-testid="composite-card-name"
          >
            {composite.name}
          </Typography>
          <Typography
            variant="caption"
            data-testid="composite-bake-status"
            display="block"
            noWrap
            title={composite.bake?.error}
            sx={{
              fontSize: "0.65rem",
              color: composite.bake?.status === "failed" ? "#fecaca" : "#aaa",
            }}
          >
            {tickToMediaSeconds(composite.content.durationTicks).toFixed(2)}s
            {" · "}
            {runtimeBake?.status === "rendering"
              ? `Baking ${Math.round(runtimeBake.progress)}%`
              : runtimeBake?.status === "queued"
                ? "Bake queued"
                : composite.bake?.status === "failed"
                  ? `Bake failed: ${composite.bake.error ?? "Retry available"}`
                  : composite.bake?.status === "ready"
                    ? "Bake ready"
                    : "Live only"}
          </Typography>
        </Box>
      </CardRoot>

      <AppMenu
        menuId="library.composite.actions"
        subject={menuSubject}
        items={menuItems}
        open={Boolean(menuAnchorEl)}
        anchorEl={menuAnchorEl}
        onClose={handleCloseMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        onClick={(event) => event.stopPropagation()}
        extensionItemTestIdPrefix="extension-composite-menu-item-"
      />
    </>
  );
}

export const CompositeCard = memo(CompositeCardComponent);
