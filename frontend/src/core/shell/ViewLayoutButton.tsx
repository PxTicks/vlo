import { useState } from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import OpenWithIcon from "@mui/icons-material/OpenWith";
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
import { AppMenu } from "./AppMenu";
import { useViewRegion } from "./useViewRegion";
import {
  DOCK_REGIONS,
  DOCK_REGION_LABELS,
  isDockRegion,
  type DockRegion,
} from "./layout/layoutTypes";
import { useShellLayoutStore } from "./layout/useShellLayoutStore";
import { hostViewRegistry, type HostViewRegion } from "./viewRegistry";

export interface ViewLayoutButtonProps {
  readonly region: HostViewRegion;
  readonly edge?: "left" | "right";
  /** Keep region geometry controls reachable when only one panel is present. */
  readonly allowSingleView?: boolean;
}

interface MoveMenuState {
  readonly anchor: HTMLElement;
  readonly viewId: string;
  readonly title: string;
  readonly regions: readonly DockRegion[];
}

/** User-owned visibility, ordering, and placement controls for one region. */
export function ViewLayoutButton({
  region,
  edge,
  allowSingleView = false,
}: ViewLayoutButtonProps) {
  const [open, setOpen] = useState(false);
  const [moveMenu, setMoveMenu] = useState<MoveMenuState | null>(null);
  // Stays set until the dialog is opened again: the dialog restores focus when
  // its close transition ends, which is after the move's own hand-off has run.
  const [movedFromRegion, setMovedFromRegion] = useState(false);
  const {
    allViews,
    isViewVisible,
    setViewVisible,
    moveView,
    movePanelToRegion,
    resetLayout,
  } = useViewRegion(region);
  const resetShellLayout = useShellLayoutStore((state) => state.resetLayout);
  const setRegionCollapsed = useShellLayoutStore(
    (state) => state.setRegionCollapsed,
  );

  // A single-view region has nothing to order and nothing safe to hide —
  // hiding the only view would empty the region with no control left to
  // restore it. Extensions contributing a view bring the control back.
  if (allViews.length <= 1 && !allowSingleView) return null;

  const closeDialog = (): void => {
    setMoveMenu(null);
    setOpen(false);
  };

  return (
    <>
      <Tooltip title="Manage panels">
        <IconButton
          aria-label="Manage panels"
          // Region-qualified: one of these renders per shell region, so the
          // label alone cannot address a specific sidebar.
          data-testid={`view-layout-button-${region}`}
          size="small"
          onClick={() => {
            setMovedFromRegion(false);
            setOpen(true);
          }}
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
      <Dialog
        open={open}
        onClose={closeDialog}
        fullWidth
        maxWidth="xs"
        // Only while a move is settling: the dialog would otherwise restore
        // focus over the top of the move's hand-off, to a trigger that may
        // have been unmounted along with its region.
        disableRestoreFocus={movedFromRegion}
      >
        <DialogTitle>Manage panels</DialogTitle>
        <DialogContent dividers>
          <List disablePadding>
            {allViews.map((view, index) => {
              // Only the regions this panel actually permits, minus the one it
              // is already in: a move menu must never offer an invalid target.
              const moveTargets = view.allowedRegions.filter(
                (candidate) => candidate !== region,
              );
              return (
                <ListItem
                  key={view.id}
                  disableGutters
                  secondaryAction={
                    <>
                      {moveTargets.length > 0 ? (
                        <IconButton
                          aria-label={`Move ${view.title} to another region`}
                          aria-haspopup="menu"
                          onClick={(event) =>
                            setMoveMenu({
                              anchor: event.currentTarget,
                              viewId: view.id,
                              title: view.title,
                              regions: moveTargets,
                            })
                          }
                        >
                          <OpenWithIcon fontSize="small" />
                        </IconButton>
                      ) : null}
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
                    disabled={allViews.length === 1}
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
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          {isDockRegion(region) ? (
            <Button onClick={() => setRegionCollapsed(region, true)}>
              Collapse region
            </Button>
          ) : null}
          <Button onClick={resetLayout}>Reset region</Button>
          {isDockRegion(region) ? (
            <Button
              onClick={() => {
                for (const dockRegion of DOCK_REGIONS) {
                  hostViewRegistry.resetRegion(dockRegion);
                }
                resetShellLayout();
              }}
            >
              Reset all regions
            </Button>
          ) : null}
          <Button onClick={closeDialog}>Done</Button>
        </DialogActions>
      </Dialog>
      {moveMenu === null || !isDockRegion(region) ? null : (
        <AppMenu
          menuId="app.view.move"
          subject={{
            slot: "app.view.move",
            view: { id: moveMenu.viewId, region },
          }}
          items={moveMenu.regions.map((target, index) => ({
            kind: "action",
            id: `move-to-${target}`,
            label: DOCK_REGION_LABELS[target],
            group: "1_regions",
            order: index,
            testId: `view-move-to-${target}`,
            run: () => {
              // The move takes focus with it to wherever the panel landed.
              if (movePanelToRegion(moveMenu.viewId, target)) {
                setMovedFromRegion(true);
              }
              // The panel has left this region, so the row this menu belongs
              // to is gone; there is nothing left in the dialog to return to.
              closeDialog();
            },
          }))}
          open
          anchorEl={moveMenu.anchor}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </>
  );
}
