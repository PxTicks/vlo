import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Box,
  Chip,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import {
  ArrowDropDown,
  ContentCopy,
  DeleteOutline,
  EditOutlined,
} from "@mui/icons-material";
import type {
  MaskBooleanExpression,
  MaskBooleanOperator,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import {
  appendMaskBooleanExpression,
  cycleMaskBooleanOperator,
  type MaskBooleanExpressionPath,
  collectMaskBooleanExpressionMaskIds,
  createMaskBooleanMaskRef,
  getMaskBooleanExpressionAtPath,
  getMaskLocalId,
  removeMaskBooleanExpressionAtPath,
  replaceMaskBooleanExpressionAtPath,
  setMaskBooleanExpressionOperatorAtPath,
  swapMaskBooleanExpressionNodes,
} from "../model/maskBooleanExpression";

interface MaskEquationBuilderProps {
  masks: MaskTimelineClip[];
  expression: MaskBooleanExpression | null;
  onExpressionChange: (expression: MaskBooleanExpression | null) => void;
  onOpenMaskDetail: (maskId: string) => void;
  onDuplicateMask: (maskId: string) => void;
  onDeleteMask: (maskId: string) => void;
  addAction?: ReactNode;
}

const OPERATOR_LABELS: Record<MaskBooleanOperator, string> = {
  union: "Union",
  intersect: "Intersect",
  subtract: "Minus",
};

function getMaskDisplayLabel(
  mask: MaskTimelineClip,
  localId: string,
  index: number,
): string {
  const name = mask.name.trim();
  if (!name || name === `Mask ${localId}`) {
    return `Mask ${index + 1}`;
  }
  return name;
}

function arePathsEqual(
  left: MaskBooleanExpressionPath,
  right: MaskBooleanExpressionPath,
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function coerceSelectedPath(
  expression: MaskBooleanExpression | null,
  path: MaskBooleanExpressionPath,
): MaskBooleanExpressionPath {
  if (!expression) {
    return [];
  }

  let nextPath = path;
  while (
    nextPath.length > 0 &&
    !getMaskBooleanExpressionAtPath(expression, nextPath)
  ) {
    nextPath = nextPath.slice(0, -1);
  }

  return nextPath;
}

export function MaskEquationBuilder({
  masks,
  expression,
  onExpressionChange,
  onOpenMaskDetail,
  onDuplicateMask,
  onDeleteMask,
  addAction,
}: MaskEquationBuilderProps) {
  const [rawSelectedPath, setSelectedPath] =
    useState<MaskBooleanExpressionPath>([]);
  const [draggedPath, setDraggedPath] = useState<MaskBooleanExpressionPath | null>(
    null,
  );
  const [draggedMaskId, setDraggedMaskId] = useState<string | null>(null);
  const [hoverDropKey, setHoverDropKey] = useState<string | null>(null);
  const [selectedLocalId, setSelectedLocalId] = useState<string | null>(null);
  const [menuState, setMenuState] = useState<{
    localId: string;
    label: string;
    anchor: HTMLElement;
  } | null>(null);

  const resetDragState = () => {
    setDraggedMaskId(null);
    setDraggedPath(null);
    setHoverDropKey(null);
  };

  const selectedPath = useMemo<MaskBooleanExpressionPath>(() => {
    if (!expression) return [];
    return coerceSelectedPath(expression, rawSelectedPath);
  }, [expression, rawSelectedPath]);

  const maskEntries = useMemo(
    () =>
      masks
        .map((mask, index) => {
          const localId = getMaskLocalId(mask);
          if (!localId) {
            return null;
          }

          return {
            clip: mask,
            index,
            localId,
            label: getMaskDisplayLabel(mask, localId, index),
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            clip: MaskTimelineClip;
            index: number;
            localId: string;
            label: string;
          } => !!entry,
        ),
    [masks],
  );
  const maskLabelById = useMemo(
    () => new Map(maskEntries.map((entry) => [entry.localId, entry.label] as const)),
    [maskEntries],
  );
  const referencedMaskIds = useMemo(
    () => new Set(collectMaskBooleanExpressionMaskIds(expression)),
    [expression],
  );
  const selectedNode = useMemo(
    () => getMaskBooleanExpressionAtPath(expression, selectedPath),
    [expression, selectedPath],
  );

  const effectiveSelectedLocalId = useMemo(() => {
    if (!selectedLocalId) return null;
    return maskEntries.some((entry) => entry.localId === selectedLocalId)
      ? selectedLocalId
      : null;
  }, [maskEntries, selectedLocalId]);

  useEffect(() => {
    if (selectedLocalId && !effectiveSelectedLocalId) {
      setSelectedLocalId(null);
    }
  }, [effectiveSelectedLocalId, selectedLocalId]);

  const handleSelectPath = (path: MaskBooleanExpressionPath) => {
    setSelectedPath(path);
  };

  const addMaskAtPath = (
    maskId: string,
    targetPath: MaskBooleanExpressionPath,
  ) => {
    const maskRef = createMaskBooleanMaskRef(maskId);

    if (!expression) {
      onExpressionChange(maskRef);
      setSelectedPath([]);
      return;
    }

    const nodeAtTarget = getMaskBooleanExpressionAtPath(
      expression,
      targetPath,
    );
    const node = nodeAtTarget ?? expression;
    const effectivePath = nodeAtTarget !== null ? targetPath : [];

    onExpressionChange(
      replaceMaskBooleanExpressionAtPath(
        expression,
        effectivePath,
        appendMaskBooleanExpression(node, maskId),
      ),
    );
    setSelectedPath(effectivePath);
  };

  const handleDeleteSelectedEquationNode = () => {
    if (!expression || selectedNode?.kind !== "mask_ref") {
      return;
    }

    const nextExpression = removeMaskBooleanExpressionAtPath(
      expression,
      selectedPath,
    );
    onExpressionChange(nextExpression);
    setSelectedPath(selectedPath.slice(0, -1));
  };

  const handleSwapMasks = (
    firstPath: MaskBooleanExpressionPath,
    secondPath: MaskBooleanExpressionPath,
  ) => {
    if (!expression) {
      return;
    }

    onExpressionChange(swapMaskBooleanExpressionNodes(expression, firstPath, secondPath));
    setSelectedPath(secondPath);
  };

  const handleEquationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "Delete" &&
      event.key !== "Backspace"
    ) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (selectedNode?.kind !== "mask_ref") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleDeleteSelectedEquationNode();
  };

  const openMaskMenu = (
    anchor: HTMLElement,
    localId: string,
    label: string,
  ) => {
    setMenuState({ anchor, localId, label });
  };

  const closeMaskMenu = () => {
    setMenuState(null);
  };

  const handleMenuEdit = () => {
    if (!menuState) return;
    onOpenMaskDetail(menuState.localId);
    closeMaskMenu();
  };

  const handleMenuDuplicate = () => {
    if (!menuState) return;
    onDuplicateMask(menuState.localId);
    closeMaskMenu();
  };

  const handleMenuDelete = () => {
    if (!menuState) return;
    onDeleteMask(menuState.localId);
    closeMaskMenu();
  };

  const handleEquationAreaDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggedMaskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (hoverDropKey !== "__area__") {
      setHoverDropKey("__area__");
    }
  };

  const handleEquationAreaDragLeave = (
    event: React.DragEvent<HTMLDivElement>,
  ) => {
    if (!draggedMaskId) return;
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) {
      return;
    }
    if (hoverDropKey === "__area__") {
      setHoverDropKey(null);
    }
  };

  const handleEquationAreaDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggedMaskId) return;
    event.preventDefault();
    addMaskAtPath(draggedMaskId, []);
    resetDragState();
  };

  const renderNode = (
    node: MaskBooleanExpression,
    path: MaskBooleanExpressionPath,
  ): ReactNode => {
    const isSelected = arePathsEqual(path, selectedPath);
    const isRootGroup = path.length === 0;

    if (node.kind === "mask_ref") {
      const pathKey = path.join("-") || "root";
      const isPathDropTarget =
        !!draggedPath && !arePathsEqual(draggedPath, path);
      const isMaskDropTarget = !!draggedMaskId;
      const isDropTarget = isPathDropTarget || isMaskDropTarget;
      const isHovered = hoverDropKey === pathKey;

      return (
        <Chip
          data-testid={`mask-equation-mask-${pathKey}`}
          label={maskLabelById.get(node.maskId) ?? `Mask ${node.maskId}`}
          size="small"
          color={isSelected || isHovered ? "primary" : "default"}
          variant={isSelected || isHovered ? "filled" : "outlined"}
          onClick={(event) => {
            event.stopPropagation();
            handleSelectPath(path);
            setSelectedLocalId(node.maskId);
          }}
          draggable
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
              "text/plain",
              path.join("/") || "root",
            );
            setDraggedPath(path);
            handleSelectPath(path);
          }}
          onDragOver={(event) => {
            if (draggedMaskId) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              if (hoverDropKey !== pathKey) {
                setHoverDropKey(pathKey);
              }
              return;
            }
            if (!draggedPath || arePathsEqual(draggedPath, path)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDragLeave={(event) => {
            if (!draggedMaskId) return;
            const related = event.relatedTarget as Node | null;
            if (related && event.currentTarget.contains(related)) {
              return;
            }
            if (hoverDropKey === pathKey) {
              setHoverDropKey(null);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (draggedMaskId) {
              addMaskAtPath(draggedMaskId, path);
              resetDragState();
              return;
            }
            if (!draggedPath || arePathsEqual(draggedPath, path)) {
              return;
            }
            handleSwapMasks(draggedPath, path);
            resetDragState();
          }}
          onDragEnd={() => {
            resetDragState();
          }}
          sx={{
            height: 24,
            borderStyle: isDropTarget ? "dashed" : "solid",
            outline: isHovered ? "2px solid" : "none",
            outlineColor: "primary.light",
            outlineOffset: 1,
            maxWidth: 160,
            "& .MuiChip-label": {
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          }}
        />
      );
    }

    return (
      <Box
        data-testid={`mask-equation-group-${path.join("-") || "root"}`}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          handleSelectPath(path);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleSelectPath(path);
          }
        }}
        sx={{
          display: isRootGroup ? "flex" : "inline-flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 0.5,
          rowGap: 0.5,
          px: 0.75,
          py: 0.5,
          borderRadius: "10px",
          border: "1px solid",
          borderColor: isSelected ? "primary.main" : "#2f333a",
          bgcolor: isSelected ? "rgba(25, 118, 210, 0.12)" : "transparent",
          minHeight: 32,
          minWidth: 0,
          maxWidth: "100%",
          width: isRootGroup ? "100%" : "fit-content",
        }}
      >
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          (
        </Typography>
        {renderNode(node.left, [...path, "left"])}
        <Chip
          label={OPERATOR_LABELS[node.operator]}
          size="small"
          color={isSelected ? "primary" : "default"}
          variant={isSelected ? "filled" : "outlined"}
          onClick={(event) => {
            event.stopPropagation();
            if (!expression) {
              return;
            }
            setSelectedPath(path);
            onExpressionChange(
              setMaskBooleanExpressionOperatorAtPath(
                expression,
                path,
                cycleMaskBooleanOperator(node.operator),
              ),
            );
          }}
          sx={{ height: 24 }}
        />
        {renderNode(node.right, [...path, "right"])}
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          )
        </Typography>
      </Box>
    );
  };

  const isEquationDropTarget = !!draggedMaskId;
  const isEquationAreaHovered = hoverDropKey === "__area__";

  return (
    <Box sx={{ px: 2, pb: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, width: "100%" }}>
          {maskEntries.map((entry) => {
            const isSelectedEntry = entry.localId === effectiveSelectedLocalId;
            const isReferenced = referencedMaskIds.has(entry.localId);
            return (
              <Chip
                key={entry.clip.id}
                data-testid={`mask-variable-chip-${entry.localId}`}
                aria-label={entry.label}
                label={entry.label}
                size="small"
                color={isSelectedEntry || isReferenced ? "primary" : "default"}
                variant={isSelectedEntry ? "filled" : "outlined"}
                onClick={() => setSelectedLocalId(entry.localId)}
                onDelete={(event) =>
                  openMaskMenu(
                    event.currentTarget as HTMLElement,
                    entry.localId,
                    entry.label,
                  )
                }
                deleteIcon={
                  <ArrowDropDown
                    role="button"
                    aria-hidden={false}
                    aria-label={`Actions for ${entry.label}`}
                    data-testid={`mask-actions-button-${entry.localId}`}
                    sx={{ fontSize: 18 }}
                  />
                }
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(
                    "text/plain",
                    `mask:${entry.localId}`,
                  );
                  setDraggedMaskId(entry.localId);
                }}
                onDragEnd={resetDragState}
                sx={{
                  height: 24,
                  maxWidth: "min(100%, 220px)",
                  "& .MuiChip-label": {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                }}
              />
            );
          })}
          {addAction}
        </Box>
      </Box>

      <Menu
        data-testid="mask-actions-menu"
        anchorEl={menuState?.anchor ?? null}
        open={!!menuState}
        onClose={closeMaskMenu}
      >
        <MenuItem
          data-testid="mask-actions-menu-edit"
          onClick={handleMenuEdit}
        >
          <ListItemIcon>
            <EditOutlined fontSize="small" />
          </ListItemIcon>
          <ListItemText>Edit</ListItemText>
        </MenuItem>
        <MenuItem
          data-testid="mask-actions-menu-duplicate"
          onClick={handleMenuDuplicate}
        >
          <ListItemIcon>
            <ContentCopy fontSize="small" />
          </ListItemIcon>
          <ListItemText>Duplicate</ListItemText>
        </MenuItem>
        <MenuItem
          data-testid="mask-actions-menu-delete"
          onClick={handleMenuDelete}
        >
          <ListItemIcon>
            <DeleteOutline fontSize="small" />
          </ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>

      <Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Equation
        </Typography>
        <Box
          data-testid="mask-equation"
          onKeyDown={handleEquationKeyDown}
          onDragOver={handleEquationAreaDragOver}
          onDragLeave={handleEquationAreaDragLeave}
          onDrop={handleEquationAreaDrop}
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1,
            minHeight: 32,
            alignItems: "center",
            minWidth: 0,
            p: 0.5,
            borderRadius: "8px",
            border: "1px dashed",
            borderColor: isEquationAreaHovered
              ? "primary.main"
              : isEquationDropTarget
                ? "rgba(25, 118, 210, 0.4)"
                : "transparent",
            bgcolor: isEquationAreaHovered
              ? "rgba(25, 118, 210, 0.12)"
              : isEquationDropTarget
                ? "rgba(25, 118, 210, 0.04)"
                : "transparent",
          }}
        >
          {expression && renderNode(expression, [])}
        </Box>
      </Box>
    </Box>
  );
}
