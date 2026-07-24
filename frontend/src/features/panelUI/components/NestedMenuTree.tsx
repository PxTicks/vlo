import {
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Add,
  ArrowBack,
  CreateNewFolder,
  DeleteOutline,
  DragIndicator,
  EditOutlined,
  FolderOutlined,
  RestartAlt,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  addMenuTreeNode,
  deleteMenuTreeNode,
  getMenuTreeChildren,
  moveMenuTreeItem,
  renameMenuTreeNode,
  type MenuTreeItem,
  type MenuTreeLayout,
  type MenuTreeNode,
} from "../../../core/shell/menuTree";
import {
  menuTreeContainerDndId,
  menuTreeItemDndId,
  resolveDropTarget,
  type MenuTreeDragData,
} from "./menuTreeDrop";

export interface NestedMenuLeaf {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface NestedMenuLeafRenderState {
  readonly selected: boolean;
  readonly editing: boolean;
  readonly activate: () => void;
}

export interface NestedMenuTreeProps<TLeaf extends NestedMenuLeaf> {
  readonly ariaLabel: string;
  readonly layout: MenuTreeLayout;
  readonly defaultLayout: MenuTreeLayout;
  readonly leaves: readonly TLeaf[];
  readonly selectedLeafId?: string | null;
  readonly onLeafActivate: (leaf: TLeaf) => void;
  readonly renderLeaf?: (
    leaf: TLeaf,
    state: NestedMenuLeafRenderState,
  ) => ReactNode;
  readonly onSave?: (layout: MenuTreeLayout) => Promise<boolean>;
  readonly onReset?: () => Promise<boolean>;
  /**
   * Editing is blocked until the persisted layout has arrived: the pre-load
   * layout shows defaults, and saving that would discard the stored one.
   */
  readonly isLoading?: boolean;
  readonly isSaving?: boolean;
  readonly persistenceError?: string | null;
}

interface NodeDialogState {
  readonly mode: "add" | "rename";
  readonly kind: "category" | "folder";
  readonly parentId: string | null;
  readonly nodeId?: string;
  readonly initialLabel: string;
}

function hasNodeChildren(layout: MenuTreeLayout, nodeId: string): boolean {
  return (
    layout.nodes.some((node) => node.parentId === nodeId) ||
    layout.leafPlacements.some((leaf) => leaf.parentId === nodeId)
  );
}

function visibleNodeIds(layout: MenuTreeLayout): Set<string> {
  const visible = new Set(
    layout.leafPlacements
      .map((leaf) => leaf.parentId)
      .filter((parentId): parentId is string => parentId !== null),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of layout.nodes) {
      if (visible.has(node.id) && node.parentId && !visible.has(node.parentId)) {
        visible.add(node.parentId);
        changed = true;
      }
    }
  }
  return visible;
}

function getNavigationParent(
  layout: MenuTreeLayout,
  node: MenuTreeNode,
): string | null {
  const parent = node.parentId
    ? layout.nodes.find((candidate) => candidate.id === node.parentId)
    : null;
  return parent?.kind === "category" ? parent.parentId : node.parentId;
}

function makeNodeId(label: string): string {
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "menu";
  return `user.${slug}.${crypto.randomUUID().slice(0, 8)}`;
}

function SortableItem({
  data,
  disabled,
  children,
}: {
  readonly data: MenuTreeDragData;
  readonly disabled: boolean;
  readonly children: (props: {
    readonly dragHandleProps: Record<string, unknown>;
    readonly isDragging: boolean;
  }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: menuTreeItemDndId(data.item),
    data,
    disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({
        dragHandleProps: { ...attributes, ...listeners },
        isDragging,
      })}
    </div>
  );
}

function DropContainer({
  parentId,
  enabled,
  children,
}: {
  readonly parentId: string | null;
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: menuTreeContainerDndId(parentId),
    data: { parentId },
    disabled: !enabled,
  });
  return (
    <Box
      ref={setNodeRef}
      sx={{
        borderRadius: 1,
        outline: isOver ? "2px solid" : "2px solid transparent",
        outlineColor: isOver ? "primary.main" : "transparent",
        outlineOffset: 2,
      }}
    >
      {children}
    </Box>
  );
}

function NodeActions({
  node,
  layout,
  onRename,
  onDelete,
  onAddFolder,
  dragHandleProps,
}: {
  readonly node: MenuTreeNode;
  readonly layout: MenuTreeLayout;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onAddFolder?: () => void;
  readonly dragHandleProps: Record<string, unknown>;
}) {
  const empty = !hasNodeChildren(layout, node.id);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      {onAddFolder && (
        <Tooltip title="Add folder">
          <IconButton
            size="small"
            aria-label={`Add folder to ${node.label}`}
            onClick={onAddFolder}
          >
            <CreateNewFolder fontSize="inherit" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Rename">
        <IconButton
          size="small"
          aria-label={`Rename ${node.label}`}
          onClick={onRename}
        >
          <EditOutlined fontSize="inherit" />
        </IconButton>
      </Tooltip>
      <Tooltip
        title={empty ? "Delete" : "Move all contents out before deleting"}
      >
        <span>
          <IconButton
            size="small"
            aria-label={`Delete ${node.label}`}
            disabled={!empty}
            onClick={onDelete}
          >
            <DeleteOutline fontSize="inherit" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Drag to reorder or move">
        <IconButton
          size="small"
          aria-label={`Move ${node.label}`}
          {...dragHandleProps}
          sx={{ cursor: "grab" }}
        >
          <DragIndicator fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export function NestedMenuTree<TLeaf extends NestedMenuLeaf>({
  ariaLabel,
  layout,
  defaultLayout,
  leaves,
  selectedLeafId = null,
  onLeafActivate,
  renderLeaf,
  onSave,
  onReset,
  isLoading = false,
  isSaving = false,
  persistenceError = null,
}: NestedMenuTreeProps<TLeaf>) {
  const [currentParentId, setCurrentParentId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layout);
  const [resetRequested, setResetRequested] = useState(false);
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState | null>(null);
  const [nodeLabel, setNodeLabel] = useState("");
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<MenuTreeItem | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeLayout = editing ? draft : layout;
  const leavesById = useMemo(
    () => new Map(leaves.map((leaf) => [leaf.id, leaf])),
    [leaves],
  );
  const nodesById = useMemo(
    () => new Map(activeLayout.nodes.map((node) => [node.id, node])),
    [activeLayout.nodes],
  );
  const visibleIds = useMemo(
    () =>
      editing
        ? new Set(activeLayout.nodes.map((node) => node.id))
        : visibleNodeIds(activeLayout),
    [activeLayout, editing],
  );

  const activeParentId =
    currentParentId && nodesById.get(currentParentId)?.kind === "folder"
      ? currentParentId
      : null;

  const childItems = getMenuTreeChildren(activeLayout, activeParentId).filter(
    (item) => item.kind === "leaf" || visibleIds.has(item.id),
  );
  const directNodes = childItems
    .filter((item): item is MenuTreeItem & { kind: "node" } => item.kind === "node")
    .map((item) => nodesById.get(item.id))
    .filter((node): node is MenuTreeNode => Boolean(node));
  const directLeaves = childItems
    .filter((item): item is MenuTreeItem & { kind: "leaf" } => item.kind === "leaf")
    .map((item) => leavesById.get(item.id))
    .filter((leaf): leaf is TLeaf => Boolean(leaf));
  const directFolders = directNodes.filter((node) => node.kind === "folder");
  const categories = directNodes.filter((node) => node.kind === "category");
  const hasInternalNodes = directFolders.length > 0 || categories.length > 0;

  // The mutation must run here rather than inside the state updater: React
  // invokes updaters during render, where a rejected edit would escape this
  // catch and unmount the tree instead of surfacing as an error.
  const mutateDraft = (mutation: (current: MenuTreeLayout) => MenuTreeLayout) => {
    let next: MenuTreeLayout;
    try {
      next = mutation(draft);
    } catch (reason) {
      setEditError(
        reason instanceof Error ? reason.message : "The menu change is invalid",
      );
      return;
    }
    setDraft(next);
    setResetRequested(false);
    setEditError(null);
  };

  const beginAdd = (
    kind: "category" | "folder",
    parentId: string | null,
  ) => {
    setNodeDialog({ mode: "add", kind, parentId, initialLabel: "" });
    setNodeLabel("");
  };

  const beginRename = (node: MenuTreeNode) => {
    setNodeDialog({
      mode: "rename",
      kind: node.kind,
      parentId: node.parentId,
      nodeId: node.id,
      initialLabel: node.label,
    });
    setNodeLabel(node.label);
  };

  const commitNodeDialog = () => {
    if (!nodeDialog || !nodeLabel.trim()) return;
    if (nodeDialog.mode === "rename" && nodeDialog.nodeId) {
      mutateDraft((current) =>
        renameMenuTreeNode(current, nodeDialog.nodeId!, nodeLabel),
      );
    } else {
      mutateDraft((current) =>
        addMenuTreeNode(current, {
          id: makeNodeId(nodeLabel),
          kind: nodeDialog.kind,
          label: nodeLabel,
          parentId: nodeDialog.parentId,
        }),
      );
    }
    setNodeDialog(null);
  };

  const handleDone = async () => {
    if (!onSave) {
      setEditing(false);
      return;
    }
    const succeeded =
      resetRequested && onReset
        ? await onReset()
        : await onSave(draft);
    if (succeeded) {
      setEditing(false);
      setResetRequested(false);
      setEditError(null);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as MenuTreeDragData | undefined;
    setActiveItem(data?.item ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveItem(null);
    const target = resolveDropTarget(draft, event);
    if (!target) return;
    mutateDraft((current) =>
      moveMenuTreeItem(current, target.item, target.parentId, target.index),
    );
  };

  const renderDragHandle = (
    item: MenuTreeItem,
    parentId: string | null,
    content: (
      dragHandleProps: Record<string, unknown>,
      isDragging: boolean,
    ) => ReactNode,
  ) => (
    <SortableItem
      key={`${item.kind}:${item.id}`}
      data={{ item, parentId }}
      disabled={!editing}
    >
      {({ dragHandleProps, isDragging }) =>
        content(dragHandleProps, isDragging)
      }
    </SortableItem>
  );

  const renderLeafItem = (leaf: TLeaf, parentId: string | null) =>
    renderDragHandle(
      { kind: "leaf", id: leaf.id },
      parentId,
      (dragHandleProps) => {
        const selected = selectedLeafId === leaf.id;
        const activate = () => {
          if (!editing && !leaf.disabled) onLeafActivate(leaf);
        };
        return (
          <Box
            key={leaf.id}
            sx={{ display: "flex", alignItems: "stretch", gap: 0.5, mb: 0.75 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {renderLeaf ? (
                renderLeaf(leaf, { selected, editing, activate })
              ) : (
                <Button
                  fullWidth
                  variant={selected ? "contained" : "outlined"}
                  color={selected ? "primary" : "inherit"}
                  disabled={leaf.disabled}
                  aria-pressed={selected}
                  onClick={activate}
                  sx={{
                    justifyContent: "flex-start",
                    textTransform: "none",
                    minHeight: 36,
                  }}
                >
                  {leaf.label}
                </Button>
              )}
            </Box>
            {editing && (
              <Tooltip title="Drag to reorder or move">
                <IconButton
                  aria-label={`Move ${leaf.label}`}
                  {...dragHandleProps}
                  sx={{ cursor: "grab" }}
                >
                  <DragIndicator fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        );
      },
    );

  const renderFolder = (node: MenuTreeNode) => (
    <DropContainer key={node.id} parentId={node.id} enabled={editing}>
      {renderDragHandle(
        { kind: "node", id: node.id },
        node.parentId,
        (dragHandleProps) => (
          <Box sx={{ display: "flex", gap: 0.5, mb: 0.75 }}>
            <Button
              fullWidth
              variant="outlined"
              color="inherit"
              startIcon={<FolderOutlined />}
              onClick={() => {
                if (!editing) setCurrentParentId(node.id);
              }}
              sx={{ justifyContent: "flex-start", textTransform: "none" }}
            >
              {node.label}
            </Button>
            {editing && (
              <NodeActions
                node={node}
                layout={draft}
                onRename={() => beginRename(node)}
                onDelete={() =>
                  mutateDraft((current) =>
                    deleteMenuTreeNode(current, node.id),
                  )
                }
                dragHandleProps={dragHandleProps}
              />
            )}
          </Box>
        ),
      )}
    </DropContainer>
  );

  const renderCategory = (node: MenuTreeNode) => {
    const categoryItems = getMenuTreeChildren(activeLayout, node.id).filter(
      (item) => item.kind === "leaf" || visibleIds.has(item.id),
    );
    const folderNodes = categoryItems
      .filter((item) => item.kind === "node")
      .map((item) => nodesById.get(item.id))
      .filter(
        (candidate): candidate is MenuTreeNode =>
          Boolean(candidate && candidate.kind === "folder"),
      );
    const categoryLeaves = categoryItems
      .filter((item) => item.kind === "leaf")
      .map((item) => leavesById.get(item.id))
      .filter((leaf): leaf is TLeaf => Boolean(leaf));
    return (
      <DropContainer key={node.id} parentId={node.id} enabled={editing}>
        {renderDragHandle(
          { kind: "node", id: node.id },
          node.parentId,
          (dragHandleProps) => (
            <Box sx={{ mb: 1.5 }}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: 32,
                  mb: 0.5,
                  borderBottom: 1,
                  borderColor: "divider",
                }}
              >
                <Typography
                  component="h3"
                  variant="overline"
                  sx={{ color: "text.secondary", fontWeight: 700 }}
                >
                  {node.label}
                </Typography>
                {editing && (
                  <NodeActions
                    node={node}
                    layout={draft}
                    onRename={() => beginRename(node)}
                    onDelete={() =>
                      mutateDraft((current) =>
                        deleteMenuTreeNode(current, node.id),
                      )
                    }
                    onAddFolder={() => beginAdd("folder", node.id)}
                    dragHandleProps={dragHandleProps}
                  />
                )}
              </Box>
              <SortableContext
                items={categoryItems.map(menuTreeItemDndId)}
                strategy={verticalListSortingStrategy}
              >
                {folderNodes.map(renderFolder)}
                {categoryLeaves.map((leaf) =>
                  renderLeafItem(leaf, node.id),
                )}
              </SortableContext>
              {editing &&
                folderNodes.length === 0 &&
                categoryLeaves.length === 0 && (
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary" }}
                  >
                    Empty category
                  </Typography>
                )}
            </Box>
          ),
        )}
      </DropContainer>
    );
  };

  const currentNode = activeParentId
    ? nodesById.get(activeParentId) ?? null
    : null;
  const breadcrumbNodes: MenuTreeNode[] = [];
  let breadcrumbNode = currentNode;
  while (breadcrumbNode) {
    breadcrumbNodes.unshift(breadcrumbNode);
    breadcrumbNode = breadcrumbNode.parentId
      ? nodesById.get(breadcrumbNode.parentId) ?? null
      : null;
  }

  const sortableIds = childItems.map(menuTreeItemDndId);

  return (
    <Box aria-label={ariaLabel}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          mb: 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          {currentNode ? (
            <Box sx={{ display: "flex", alignItems: "center" }}>
              <IconButton
                size="small"
                aria-label="Back to previous menu"
                onClick={() =>
                  setCurrentParentId(
                    getNavigationParent(activeLayout, currentNode),
                  )
                }
              >
                <ArrowBack fontSize="small" />
              </IconButton>
              <Breadcrumbs
                aria-label={`${ariaLabel} path`}
                sx={{ "& .MuiBreadcrumbs-li": { fontSize: 12 } }}
              >
                <Typography variant="caption">Menu</Typography>
                {breadcrumbNodes.map((node) => (
                  <Typography key={node.id} variant="caption">
                    {node.label}
                  </Typography>
                ))}
              </Breadcrumbs>
            </Box>
          ) : (
            <Typography variant="subtitle2">Workflow menu</Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          {!editing && onSave && (
            <Button
              size="small"
              startIcon={<EditOutlined />}
              disabled={isLoading}
              onClick={() => {
                setDraft(layout);
                setEditing(true);
                setResetRequested(false);
                setEditError(null);
              }}
            >
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button
                size="small"
                startIcon={<Add />}
                onClick={() => beginAdd("category", activeParentId)}
              >
                Category
              </Button>
              <Button
                size="small"
                startIcon={<CreateNewFolder />}
                onClick={() => beginAdd("folder", activeParentId)}
              >
                Folder
              </Button>
            </>
          )}
        </Box>
      </Box>

      {editing && (
        <Box sx={{ display: "flex", gap: 0.75, mb: 1, flexWrap: "wrap" }}>
          <Button
            size="small"
            variant="contained"
            disabled={isSaving}
            onClick={() => void handleDone()}
          >
            Done
          </Button>
          <Button
            size="small"
            disabled={isSaving}
            onClick={() => {
              setDraft(layout);
              setEditing(false);
              setResetRequested(false);
              setEditError(null);
            }}
          >
            Cancel
          </Button>
          {onReset && (
            <Button
              size="small"
              color="warning"
              startIcon={<RestartAlt />}
              disabled={isSaving}
              onClick={() => setResetDialogOpen(true)}
            >
              Reset defaults
            </Button>
          )}
        </Box>
      )}

      {(persistenceError || editError) && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {editError ?? persistenceError}
        </Alert>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveItem(null)}
        onDragEnd={handleDragEnd}
      >
        <DropContainer parentId={activeParentId} enabled={editing}>
          <SortableContext
            items={sortableIds}
            strategy={verticalListSortingStrategy}
          >
            {directFolders.map(renderFolder)}
            {categories.map(renderCategory)}
            {directLeaves.length > 0 && hasInternalNodes && (
              <Typography
                component="h3"
                variant="overline"
                sx={{
                  display: "block",
                  color: "text.secondary",
                  fontWeight: 700,
                  borderBottom: 1,
                  borderColor: "divider",
                  mb: 0.75,
                }}
              >
                Other
              </Typography>
            )}
            {directLeaves.map((leaf) =>
              renderLeafItem(leaf, activeParentId),
            )}
            {childItems.length === 0 && (
              <Typography variant="body2" sx={{ color: "text.secondary", py: 1 }}>
                {editing ? "This folder is empty." : "No items available."}
              </Typography>
            )}
          </SortableContext>
        </DropContainer>
        <DragOverlay>
          {activeItem ? (
            <Box
              sx={{
                px: 1.5,
                py: 0.75,
                bgcolor: "background.paper",
                border: 1,
                borderColor: "primary.main",
                borderRadius: 1,
                boxShadow: 4,
              }}
            >
              {activeItem.kind === "node"
                ? nodesById.get(activeItem.id)?.label
                : leavesById.get(activeItem.id)?.label}
            </Box>
          ) : null}
        </DragOverlay>
      </DndContext>

      <Dialog
        open={nodeDialog !== null}
        onClose={() => setNodeDialog(null)}
        transitionDuration={0}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>
          {nodeDialog?.mode === "rename"
            ? `Rename ${nodeDialog.kind}`
            : `Add ${nodeDialog?.kind}`}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Name"
            value={nodeLabel}
            inputProps={{ maxLength: 80 }}
            onChange={(event) => setNodeLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitNodeDialog();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNodeDialog(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!nodeLabel.trim()}
            onClick={commitNodeDialog}
          >
            {nodeDialog?.mode === "rename" ? "Rename" : "Add"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={resetDialogOpen}
        onClose={() => setResetDialogOpen(false)}
        transitionDuration={0}
      >
        <DialogTitle>Reset menu to defaults?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Custom folders, categories, names, and ordering will be discarded
            when you choose Done.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetDialogOpen(false)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              setDraft(defaultLayout);
              setResetRequested(true);
              setResetDialogOpen(false);
              setEditError(null);
            }}
          >
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
