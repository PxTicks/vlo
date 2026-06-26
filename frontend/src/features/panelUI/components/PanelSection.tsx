import { useState, memo } from "react";
import { Box, Typography, IconButton, Switch } from "@mui/material";
import {
  ExpandMore,
  ExpandLess,
  DragIndicator,
  Close,
} from "@mui/icons-material";

interface SectionToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

interface PanelSectionProps {
  title: string;
  children: React.ReactNode;
  onRemove?: () => void;
  defaultOpen?: boolean;

  // Styling Props
  bgColor: string;

  // Drag Props
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
  dimmed?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  sectionToggle?: SectionToggleProps;
  isActive?: boolean;
  onSectionClick?: () => void;
  headerActions?: React.ReactNode;
}

export const PanelSection = memo(function PanelSection({
  title,
  children,
  onRemove,
  defaultOpen = true,
  bgColor,
  dragHandleProps,
  isDragging,
  dimmed,
  isOpen: controlledIsOpen,
  onToggle,
  sectionToggle,
  isActive,
  onSectionClick,
  headerActions,
}: PanelSectionProps) {
  const [localIsOpen, setLocalIsOpen] = useState(defaultOpen);

  const isOpen = controlledIsOpen ?? localIsOpen;
  const handleToggle = onToggle ?? (() => setLocalIsOpen(!localIsOpen));

  return (
    <Box
      onClick={() => onSectionClick?.()}
      sx={{
        bgcolor: bgColor,
        py: 1,
        px: 1.5,
        opacity: dimmed ? 0.5 : 1,
        border: "1px solid",
        borderColor: isDragging
          ? "primary.main"
          : isActive
            ? "secondary.main"
            : "divider",
        borderRadius: 1,
        mb: 1,
      }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: isOpen ? 1 : 0,
          cursor: "pointer",
        }}
        onClick={handleToggle}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Drag Handle */}
          {dragHandleProps && (
            <Box
              {...dragHandleProps}
              onClick={(e) => e.stopPropagation()} // Prevent collapse toggle
              sx={{
                p: 0.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "grab",
                borderRadius: 1,
                "&:active": { cursor: "grabbing" },
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <DragIndicator
                fontSize="small"
                sx={{ color: "text.secondary", fontSize: 18 }}
              />
            </Box>
          )}

          {isOpen ? (
            <ExpandLess fontSize="small" color="action" />
          ) : (
            <ExpandMore fontSize="small" color="action" />
          )}
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 600, color: "text.primary", userSelect: "none" }}
          >
            {title}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {headerActions && (
            <Box
              onClick={(e) => e.stopPropagation()}
              sx={{ display: "flex", alignItems: "center", gap: 0.25 }}
            >
              {headerActions}
            </Box>
          )}

          {sectionToggle && (
            <Switch
              size="small"
              checked={sectionToggle.checked}
              disabled={sectionToggle.disabled}
              slotProps={{
                input: {
                  "aria-label": sectionToggle.ariaLabel ?? `${title} enabled`,
                },
              }}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                sectionToggle.onChange(e.target.checked);
              }}
              sx={{
                width: 34,
                height: 20,
                p: 0,
                mx: 0.25,
                "& .MuiSwitch-switchBase": {
                  p: 0.25,
                  "&.Mui-checked": {
                    transform: "translateX(14px)",
                    color: "common.white",
                    "& + .MuiSwitch-track": {
                      bgcolor: "primary.main",
                      opacity: 1,
                    },
                  },
                  "&.Mui-disabled + .MuiSwitch-track": {
                    opacity: 0.35,
                  },
                },
                "& .MuiSwitch-thumb": {
                  width: 16,
                  height: 16,
                  boxShadow: "none",
                },
                "& .MuiSwitch-track": {
                  borderRadius: 10,
                  bgcolor: "action.disabledBackground",
                  opacity: 1,
                },
              }}
            />
          )}

          {onRemove && (
            <IconButton
              size="small"
              aria-label="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              sx={{
                p: 0.5,
                color: "text.secondary",
                "&:hover": { color: "error.main", bgcolor: "error.soft" },
              }}
            >
              <Close fontSize="small" sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Box>
      </Box>

      {isOpen && <Box sx={{ pl: dragHandleProps ? 4 : 0.5 }}>{children}</Box>}
    </Box>
  );
});
