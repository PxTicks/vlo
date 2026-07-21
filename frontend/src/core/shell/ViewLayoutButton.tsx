import { useState } from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
} from "@mui/material";
import { useViewRegion } from "./useViewRegion";
import type { HostViewRegion } from "./viewRegistry";

export interface ViewLayoutButtonProps {
  readonly region: HostViewRegion;
  readonly edge?: "left" | "right";
}

/** User-owned visibility and ordering controls for one shell region. */
export function ViewLayoutButton({ region, edge }: ViewLayoutButtonProps) {
  const [open, setOpen] = useState(false);
  const { allViews, isViewVisible, setViewVisible, moveView, resetLayout } =
    useViewRegion(region);

  return (
    <>
      <Tooltip title="Manage panels">
        <IconButton
          aria-label="Manage panels"
          // Region-qualified: one of these renders per shell region, so the
          // label alone cannot address a specific sidebar.
          data-testid={`view-layout-button-${region}`}
          size="small"
          onClick={() => setOpen(true)}
          sx={{
            width: 32,
            minHeight: 36,
            flexShrink: 0,
            borderRadius: 0,
            borderLeft: edge === "right" ? "1px solid #333" : undefined,
            borderRight: edge === "left" ? "1px solid #333" : undefined,
            color: "text.secondary",
          }}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Manage panels</DialogTitle>
        <DialogContent dividers>
          <List disablePadding>
            {allViews.map((view, index) => (
              <ListItem
                key={view.id}
                disableGutters
                secondaryAction={
                  <>
                    <IconButton
                      aria-label={`Move ${view.title} up`}
                      disabled={index === 0}
                      onClick={() => moveView(view.id, -1)}
                    >
                      <ArrowUpwardIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      aria-label={`Move ${view.title} down`}
                      disabled={index === allViews.length - 1}
                      onClick={() => moveView(view.id, 1)}
                    >
                      <ArrowDownwardIcon fontSize="small" />
                    </IconButton>
                  </>
                }
              >
                <Checkbox
                  edge="start"
                  checked={isViewVisible(view.id)}
                  onChange={(_, checked) => setViewVisible(view.id, checked)}
                  inputProps={{ "aria-label": `Show ${view.title}` }}
                />
                <ListItemText
                  primary={view.title}
                  secondary={
                    view.source === "extension" ? "Extension" : "Built in"
                  }
                />
              </ListItem>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={resetLayout}>Reset</Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
