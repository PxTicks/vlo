import { useEffect, useState, type MouseEvent } from "react";
import DeleteIcon from "@mui/icons-material/Delete";
import HistoryIcon from "@mui/icons-material/History";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import {
  Box,
  CardActionArea,
  IconButton,
  List,
  ListItem,
  Typography,
} from "@mui/material";
import { alpha, styled } from "@mui/material/styles";
import { useHostContextMenu } from "../../../core/shell/useHostContextMenu";
import { fileSystemService } from "../services/FileSystemService";
import { ProjectSchemaVersionError } from "../services/ProjectPersistenceService";
import {
  recentProjectsService,
  type RecentProject,
} from "../services/RecentProjectsService";
import { useProjectStore } from "../useProjectStore";

const BRAND_PRIMARY = "#73CEBD";
const BRAND_SECONDARY = "#8DA9FF";

const RecentProjectButton = styled(CardActionArea)(({ theme }) => ({
  flexGrow: 1,
  borderRadius: 22,
  padding: theme.spacing(2),
  border: `1px solid ${alpha("#FFFFFF", 0.08)}`,
  backgroundColor: alpha("#FFFFFF", 0.03),
  transition: theme.transitions.create(
    ["transform", "background-color", "border-color"],
    { duration: theme.transitions.duration.shorter },
  ),
  "&:hover": {
    transform: "translateY(-1px)",
    borderColor: alpha(BRAND_PRIMARY, 0.22),
    backgroundColor: alpha(BRAND_PRIMARY, 0.08),
  },
}));

const recentDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function getOpenErrorMessage(error: unknown): string {
  if (error instanceof ProjectSchemaVersionError) {
    return `Failed to open recent project: ${error.message}`;
  }
  return "Failed to open recent project. It may have been moved or deleted.";
}

export function RecentProjectsView() {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  const loadProject = useProjectStore((state) => state.loadProject);
  const showContextMenu = useHostContextMenu();

  async function loadRecents() {
    setRecents(await recentProjectsService.getRecents());
  }

  useEffect(() => {
    let current = true;
    void recentProjectsService.getRecents().then((items) => {
      if (current) setRecents(items);
    });
    return () => {
      current = false;
    };
  }, []);

  async function handleRecentClick(recent: RecentProject) {
    try {
      setLoading(true);
      const hasPermission = await fileSystemService.verifyPermission(
        recent.handle,
        true,
      );
      if (hasPermission) await loadProject(recent.handle);
    } catch (error: unknown) {
      console.error(error);
      alert(getOpenErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveRecent(event: MouseEvent | null, id: string) {
    event?.stopPropagation();
    await recentProjectsService.removeRecent(id);
    await loadRecents();
  }

  function handleContextMenu(event: MouseEvent, recent: RecentProject) {
    event.preventDefault();
    showContextMenu({
      menuId: "projects.item.context",
      subject: {
        slot: "projects.item.context",
        project: {
          id: recent.id,
          name: recent.name,
          lastOpened: recent.lastOpened,
          pathToken: recent.id,
        },
      },
      position: { x: event.clientX, y: event.clientY },
      items: [
        {
          kind: "command",
          id: "open",
          command: "projects.open",
          subject: { recentId: recent.id },
          label: "Open project",
          group: "1_open",
        },
        {
          kind: "action",
          id: "remove",
          label: "Remove from recents",
          group: "9_manage",
          run: () => void handleRemoveRecent(null, recent.id),
        },
      ],
    });
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", p: { xs: 3, md: 4 } }}>
      <Box
        sx={{
          display: "flex",
          alignItems: { xs: "flex-start", sm: "center" },
          justifyContent: "space-between",
          gap: 2,
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="overline"
            sx={{ color: alpha("#FFFFFF", 0.54), letterSpacing: "0.16em" }}
          >
            Workspace history
          </Typography>
          <Typography
            variant="h4"
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              mt: 0.75,
              fontWeight: 700,
              letterSpacing: "-0.04em",
            }}
          >
            <HistoryIcon sx={{ color: BRAND_PRIMARY }} />
            Recent Projects
          </Typography>
          <Typography
            variant="body2"
            sx={{ color: alpha("#FFFFFF", 0.64), mt: 1 }}
          >
            Reopen a project directory instantly or clean up stale entries.
          </Typography>
        </Box>
        <Box
          sx={{
            flexShrink: 0,
            minWidth: 72,
            px: 2,
            py: 1.25,
            borderRadius: 4,
            textAlign: "center",
            border: `1px solid ${alpha(BRAND_SECONDARY, 0.22)}`,
            backgroundColor: alpha(BRAND_SECONDARY, 0.08),
          }}
        >
          <Typography variant="h5" fontWeight={700}>
            {recents.length}
          </Typography>
          <Typography variant="caption" sx={{ color: alpha("#FFFFFF", 0.58) }}>
            saved
          </Typography>
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pr: { xs: 0.75, md: 1.5 }, pb: 1 }}>
        {recents.length === 0 ? (
          <Box
            sx={{
              height: "100%",
              minHeight: 280,
              display: "grid",
              placeItems: "center",
              borderRadius: 5,
              border: `1px dashed ${alpha("#FFFFFF", 0.12)}`,
              backgroundColor: alpha("#FFFFFF", 0.02),
              textAlign: "center",
              px: 3,
            }}
          >
            <Box>
              <Box
                sx={{
                  display: "grid",
                  placeItems: "center",
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  mx: "auto",
                  mb: 2,
                  backgroundColor: alpha(BRAND_PRIMARY, 0.12),
                  color: BRAND_PRIMARY,
                }}
              >
                <HistoryIcon />
              </Box>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>
                No recent projects yet
              </Typography>
              <Typography
                variant="body2"
                sx={{ color: alpha("#FFFFFF", 0.58), maxWidth: 360 }}
              >
                Create a new project or open an existing directory to start
                building your recent list.
              </Typography>
            </Box>
          </Box>
        ) : (
          <List disablePadding sx={{ display: "grid", gap: 1.25 }}>
            {recents.map((recent) => (
              <ListItem key={recent.id} disablePadding>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, width: "100%" }}>
                  <RecentProjectButton
                    disabled={loading}
                    onClick={() => void handleRecentClick(recent)}
                    onContextMenu={(event) => handleContextMenu(event, recent)}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", gap: 2, width: "100%" }}>
                      <Box
                        sx={{
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          width: 56,
                          height: 56,
                          borderRadius: 3.5,
                          border: `1px solid ${alpha(BRAND_PRIMARY, 0.18)}`,
                          backgroundColor: alpha(BRAND_PRIMARY, 0.1),
                          color: BRAND_PRIMARY,
                        }}
                      >
                        <VideoFileIcon />
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          variant="h6"
                          sx={{
                            fontSize: "1.15rem",
                            fontWeight: 700,
                            letterSpacing: "-0.02em",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {recent.name}
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{ color: alpha("#FFFFFF", 0.56), mt: 0.5 }}
                        >
                          Last opened {recentDateFormatter.format(new Date(recent.lastOpened))}
                        </Typography>
                      </Box>
                    </Box>
                  </RecentProjectButton>
                  <IconButton
                    onClick={(event) => void handleRemoveRecent(event, recent.id)}
                    aria-label={`Remove ${recent.name} from recents`}
                    sx={{
                      flexShrink: 0,
                      width: 44,
                      height: 44,
                      color: alpha("#FFFFFF", 0.48),
                      border: `1px solid ${alpha("#FFFFFF", 0.08)}`,
                      backgroundColor: alpha("#FFFFFF", 0.02),
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Box>
  );
}
