import {
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Box, Chip, IconButton, Tooltip, Typography } from "@mui/material";
import { ContentCopy, DeleteOutline, EditOutlined } from "@mui/icons-material";
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

  const handleSelectPath = (path: MaskBooleanExpressionPath) => {
    setSelectedPath(path);
  };

  const handleUseMask = (maskId: string) => {
    const maskRef = createMaskBooleanMaskRef(maskId);

    if (!expression) {
      onExpressionChange(maskRef);
      setSelectedPath([]);
      return;
    }

    const targetPath = selectedNode ? selectedPath : [];
    const node =
      getMaskBooleanExpressionAtPath(expression, targetPath) ?? expression;
    if (!node) {
      onExpressionChange(maskRef);
      setSelectedPath([]);
      return;
    }

    onExpressionChange(
      replaceMaskBooleanExpressionAtPath(
        expression,
        targetPath,
        appendMaskBooleanExpression(node, maskId),
      ),
    );
    setSelectedPath(targetPath);
  };

  const handleDeleteSelectedMask = () => {
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
    handleDeleteSelectedMask();
  };

  const helperText = !expression
    ? "Click a mask chip to start the equation."
    : selectedNode?.kind === "operation"
      ? "Click a mask chip to union it into the selected group. Click the operator chip to cycle it."
      : "Select a mask chip, press Delete to remove it, or drag it onto another mask chip to swap them.";

  const renderNode = (
    node: MaskBooleanExpression,
    path: MaskBooleanExpressionPath,
  ): ReactNode => {
    const isSelected = arePathsEqual(path, selectedPath);
    const isRootGroup = path.length === 0;

    if (node.kind === "mask_ref") {
      const isDropTarget =
        !!draggedPath &&
        !arePathsEqual(draggedPath, path);

      return (
        <Chip
          data-testid={`mask-equation-mask-${path.join("-") || "root"}`}
          label={maskLabelById.get(node.maskId) ?? `Mask ${node.maskId}`}
          size="small"
          color={isSelected ? "primary" : "default"}
          variant={isSelected ? "filled" : "outlined"}
          onClick={(event) => {
            event.stopPropagation();
            handleSelectPath(path);
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
            if (!draggedPath || arePathsEqual(draggedPath, path)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!draggedPath || arePathsEqual(draggedPath, path)) {
              return;
            }
            handleSwapMasks(draggedPath, path);
            setDraggedPath(null);
          }}
          onDragEnd={() => {
            setDraggedPath(null);
          }}
          sx={{
            height: 24,
            borderStyle: isDropTarget ? "dashed" : "solid",
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

  return (
    <Box sx={{ px: 2, pb: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Available Masks
        </Typography>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, width: "100%" }}>
          {maskEntries.map((entry) => (
            <Box
              key={entry.clip.id}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                minWidth: 0,
                width: "100%",
              }}
            >
              <Chip
                data-testid={`mask-variable-chip-${entry.localId}`}
                label={entry.label}
                size="small"
                color={referencedMaskIds.has(entry.localId) ? "primary" : "default"}
                variant={referencedMaskIds.has(entry.localId) ? "filled" : "outlined"}
                onClick={() => handleUseMask(entry.localId)}
                sx={{
                  height: 24,
                  minWidth: 0,
                  maxWidth: "min(100%, 220px)",
                  flex: "0 1 auto",
                  "& .MuiChip-label": {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                }}
              />
              <Tooltip title="Edit mask">
                <IconButton
                  data-testid={`mask-edit-button-${entry.localId}`}
                  aria-label={`Edit ${entry.label}`}
                  size="small"
                  onClick={() => onOpenMaskDetail(entry.localId)}
                  sx={{
                    border: "1px solid",
                    borderColor: "#2f333a",
                    borderRadius: 999,
                    p: 0.5,
                  }}
                >
                  <EditOutlined sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Duplicate mask">
                <IconButton
                  data-testid={`mask-duplicate-button-${entry.localId}`}
                  aria-label={`Duplicate ${entry.label}`}
                  size="small"
                  onClick={() => onDuplicateMask(entry.localId)}
                  sx={{
                    border: "1px solid",
                    borderColor: "#2f333a",
                    borderRadius: 999,
                    p: 0.5,
                  }}
                >
                  <ContentCopy sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete mask">
                <IconButton
                  data-testid={`mask-delete-inline-button-${entry.localId}`}
                  aria-label={`Delete ${entry.label}`}
                  size="small"
                  onClick={() => onDeleteMask(entry.localId)}
                  sx={{
                    border: "1px solid",
                    borderColor: "#2f333a",
                    borderRadius: 999,
                    p: 0.5,
                  }}
                >
                  <DeleteOutline sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
          {addAction}
        </Box>
      </Box>

      <Box>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Equation
        </Typography>
        {expression ? (
          <Box
            data-testid="mask-equation"
            onKeyDown={handleEquationKeyDown}
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 1,
              minHeight: 32,
              alignItems: "center",
              minWidth: 0,
            }}
          >
            {renderNode(expression, [])}
          </Box>
        ) : (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", minHeight: 20 }}
          >
            No equation yet.
          </Typography>
        )}
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {helperText}
        </Typography>
      </Box>
    </Box>
  );
}
