import { useEffect, useState, type MouseEvent } from "react";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import HistoryIcon from "@mui/icons-material/History";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import {
  Alert,
  Box,
  Button,
  CardActionArea,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha, styled } from "@mui/material/styles";

import vloLogo from "../../../assets/vlo.svg";
import { fileSystemService } from "../services/FileSystemService";
import {
  recentProjectsService,
  type RecentProject,
} from "../services/RecentProjectsService";
import { useProjectStore } from "../useProjectStore";
import type { AspectRatio } from "../useProjectStore";
import { isNonChromiumBrowser } from "../utils/browser";

const BRAND_PRIMARY = "#73CEBD";
const BRAND_SECONDARY = "#8DA9FF";

const ASPECT_RATIO_OPTIONS: Array<{
  value: AspectRatio;
  label: string;
  sub: string;
}> = [
  { value: "16:9", label: "Horizontal", sub: "16:9" },
  { value: "9:16", label: "Vertical", sub: "9:16" },
  { value: "1:1", label: "Square", sub: "1:1" },
];

const FPS_OPTIONS: Array<{ value: number; label: string; sub: string }> = [
  { value: 16, label: "16 fps", sub: "Wan" },
  { value: 24, label: "24 fps", sub: "LTX" },
];

const recentDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const LandingPanel = styled(Box)({
  position: "relative",
  minHeight: 0,
  overflow: "hidden",
  borderRadius: 32,
  border: `1px solid ${alpha("#FFFFFF", 0.12)}`,
  background: `linear-gradient(180deg, ${alpha("#10191B", 0.92)} 0%, ${alpha(
    "#091013",
    0.9,
  )} 100%)`,
  boxShadow: "0 32px 80px rgba(0, 0, 0, 0.38)",
  backdropFilter: "blur(28px)",
});

const ActionButton = styled(Button)(({ theme }) => ({
  justifyContent: "flex-start",
  padding: theme.spacing(2.25, 2.5),
  borderRadius: 22,
  textTransform: "none",
  fontSize: theme.typography.h6.fontSize,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  boxShadow: "none",
  "& .MuiButton-startIcon": {
    marginRight: theme.spacing(1.5),
  },
}));

const RecentProjectButton = styled(CardActionArea)(({ theme }) => ({
  flexGrow: 1,
  borderRadius: 22,
  padding: theme.spacing(2),
  border: `1px solid ${alpha("#FFFFFF", 0.08)}`,
  backgroundColor: alpha("#FFFFFF", 0.03),
  transition: theme.transitions.create(
    ["transform", "background-color", "border-color"],
    {
      duration: theme.transitions.duration.shorter,
    },
  ),
  "&:hover": {
    transform: "translateY(-1px)",
    borderColor: alpha(BRAND_PRIMARY, 0.22),
    backgroundColor: alpha(BRAND_PRIMARY, 0.08),
  },
}));

function formatLastOpened(lastOpened: number): string {
  return recentDateFormatter.format(new Date(lastOpened));
}

export function ProjectManager() {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [parentHandle, setParentHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] =
    useState<AspectRatio>("16:9");
  const [selectedFps, setSelectedFps] = useState<number>(16);
  const [isNonChromium, setIsNonChromium] = useState<boolean>(false);

  const loadProject = useProjectStore((state) => state.loadProject);
  const createProject = useProjectStore((state) => state.createProject);

  useEffect(() => {
    void loadRecents();
    setIsNonChromium(isNonChromiumBrowser());
  }, []);

  async function loadRecents() {
    const list = await recentProjectsService.getRecents();
    setRecents(list);
  }

  async function handleOpenProject() {
    try {
      setLoading(true);
      const handle = await window.showDirectoryPicker({
        id: "vlo-project",
        startIn: "videos",
      });
      await loadProject(handle);
    } catch (e: unknown) {
      const err = e as Error;

      if (err.name !== "AbortError") {
        console.error(err);
        alert("Failed to open project: " + err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRecentClick(recent: RecentProject) {
    try {
      setLoading(true);
      const hasPermission = await fileSystemService.verifyPermission(
        recent.handle,
        true,
      );

      if (!hasPermission) {
        return;
      }

      await loadProject(recent.handle);
    } catch (e: unknown) {
      console.error(e);
      alert(
        "Failed to open recent project. It may have been moved or deleted.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveRecent(event: MouseEvent, id: string) {
    event.stopPropagation();
    await recentProjectsService.removeRecent(id);
    await loadRecents();
  }

  async function handleCreateClick() {
    try {
      const handle = await window.showDirectoryPicker({
        id: "vlo-workspace",
        startIn: "videos",
      });
      setParentHandle(handle);
      setCreateOpen(true);
    } catch (e: unknown) {
      if ((e as Error).name !== "AbortError") {
        console.error(e);
      }
    }
  }

  async function handleCreateConfirm() {
    if (!parentHandle || !newProjectName.trim()) {
      return;
    }

    try {
      setLoading(true);
      await createProject(newProjectName, parentHandle, {
        aspectRatio: selectedAspectRatio,
        fps: selectedFps,
      });
      setCreateOpen(false);
    } catch (e: unknown) {
      const err = e as Error;
      console.error(err);
      alert("Failed to create project: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Box
      sx={{
        position: "relative",
        height: "100dvh",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        overflowX: "hidden",
        overflowY: "auto",
        px: { xs: 2, md: 3 },
        py: { xs: 2, md: 3 },
        color: "#F4FBF9",
        backgroundColor: "#081111",
        backgroundImage: `
          radial-gradient(circle at 12% 18%, rgba(115, 206, 189, 0.22) 0, transparent 34%),
          radial-gradient(circle at 85% 14%, rgba(141, 169, 255, 0.18) 0, transparent 26%),
          radial-gradient(circle at 70% 85%, rgba(115, 206, 189, 0.12) 0, transparent 22%),
          linear-gradient(145deg, #050a0c 0%, #081013 44%, #101217 100%)
        `,
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: "auto auto -12% -4%",
          width: { xs: 240, md: 420 },
          height: { xs: 240, md: 420 },
          borderRadius: "50%",
          background: alpha(BRAND_PRIMARY, 0.08),
          filter: "blur(60px)",
          pointerEvents: "none",
        }}
      />

      <Box
        sx={{
          position: "absolute",
          inset: "-8% -6% auto auto",
          width: { xs: 220, md: 360 },
          height: { xs: 220, md: 360 },
          borderRadius: "50%",
          background: alpha(BRAND_SECONDARY, 0.08),
          filter: "blur(72px)",
          pointerEvents: "none",
        }}
      />

      <Box
        sx={{
          position: "relative",
          zIndex: 1,
          flex: { xs: "0 0 auto", lg: 1 },
          minHeight: { xs: "auto", lg: 0 },
          display: "grid",
          gap: 2,
          gridTemplateColumns: {
            xs: "1fr",
            lg: "minmax(420px, 0.9fr) minmax(520px, 1.1fr)",
          },
        }}
      >
        <LandingPanel
          sx={{
            display: "flex",
            flexDirection: "column",
            overflowX: "hidden",
            overflowY: "auto",
            p: { xs: 3, md: 5 },
          }}
        >
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(180deg, ${alpha(
                BRAND_PRIMARY,
                0.1,
              )} 0%, transparent 42%)`,
              pointerEvents: "none",
            }}
          />

          <Box
            sx={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: { xs: 2, md: 2.5 },
              mb: 3,
            }}
          >
            <Box
              sx={{
                display: "grid",
                placeItems: "center",
                width: { xs: 72, md: 88 },
                height: { xs: 72, md: 88 },
                borderRadius: 5,
                border: `1px solid ${alpha(BRAND_PRIMARY, 0.24)}`,
                backgroundColor: alpha("#081413", 0.74),
                boxShadow: `inset 0 1px 0 ${alpha(
                  "#FFFFFF",
                  0.08,
                )}, 0 24px 48px rgba(0, 0, 0, 0.22)`,
              }}
            >
              <Box
                component="img"
                src={vloLogo}
                alt="vlo logo"
                sx={{ width: { xs: 42, md: 52 }, height: { xs: 42, md: 52 } }}
              />
            </Box>

            <Box>
              <Typography
                component="h1"
                variant="h1"
                sx={{
                  fontSize: { xs: "3.1rem", md: "4.5rem" },
                  lineHeight: 0.95,
                  fontWeight: 800,
                  letterSpacing: "-0.06em",
                }}
              >
                vlo
              </Typography>
              <Typography
                variant="body1"
                sx={{ color: alpha("#FFFFFF", 0.64), mt: 0.75 }}
              >
                Project directory launcher
              </Typography>
            </Box>
          </Box>

          <Box
            sx={{
              position: "relative",
              display: "grid",
              gap: 1.5,
              width: "100%",
              maxWidth: 520,
            }}
          >
            {isNonChromium && (
              <Alert severity="warning" sx={{ mb: 1, borderRadius: 3 }}>
                vlo requires Chromium-based browsers (Chrome, Edge, Brave,
                Opera) for Local File System Access API support.
              </Alert>
            )}

            <ActionButton
              variant="contained"
              startIcon={<CreateNewFolderIcon />}
              onClick={handleCreateClick}
              disabled={loading}
              sx={{
                color: "#08110F",
                background: `linear-gradient(135deg, ${BRAND_PRIMARY} 0%, #A5E7DA 100%)`,
                "&:hover": {
                  background: `linear-gradient(135deg, #82d9ca 0%, #B5EFE4 100%)`,
                },
              }}
            >
              New project
            </ActionButton>

            <ActionButton
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={handleOpenProject}
              disabled={loading}
              sx={{
                color: "#F4FBF9",
                borderColor: alpha("#FFFFFF", 0.16),
                backgroundColor: alpha("#FFFFFF", 0.03),
                "&:hover": {
                  borderColor: alpha(BRAND_PRIMARY, 0.32),
                  backgroundColor: alpha(BRAND_PRIMARY, 0.08),
                },
              }}
            >
              Open project
            </ActionButton>
          </Box>

          <Typography
            variant="body2"
            sx={{
              position: "relative",
              mt: "auto",
              pt: 4,
              color: alpha("#FFFFFF", 0.52),
            }}
          >
            vlo v0.1
          </Typography>
        </LandingPanel>

        <LandingPanel
          sx={{
            display: "flex",
            flexDirection: "column",
            p: { xs: 3, md: 4 },
          }}
        >
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
                sx={{
                  color: alpha("#FFFFFF", 0.54),
                  letterSpacing: "0.16em",
                }}
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
              <Typography
                variant="caption"
                sx={{ color: alpha("#FFFFFF", 0.58) }}
              >
                saved
              </Typography>
            </Box>
          </Box>

          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              pr: { xs: 0.75, md: 1.5 },
              pb: 1,
            }}
          >
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
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.25,
                        width: "100%",
                      }}
                    >
                      <RecentProjectButton
                        onClick={() => handleRecentClick(recent)}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 2,
                            width: "100%",
                          }}
                        >
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
                              Last opened {formatLastOpened(recent.lastOpened)}
                            </Typography>
                          </Box>
                        </Box>
                      </RecentProjectButton>

                      <IconButton
                        onClick={(event) =>
                          void handleRemoveRecent(event, recent.id)
                        }
                        aria-label={`Remove ${recent.name} from recents`}
                        sx={{
                          flexShrink: 0,
                          width: 44,
                          height: 44,
                          color: alpha("#FFFFFF", 0.48),
                          border: `1px solid ${alpha("#FFFFFF", 0.08)}`,
                          backgroundColor: alpha("#FFFFFF", 0.02),
                          "&:hover": {
                            color: "#FFFFFF",
                            borderColor: alpha("#FFFFFF", 0.16),
                            backgroundColor: alpha("#FFFFFF", 0.06),
                          },
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
        </LandingPanel>
      </Box>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        PaperProps={{
          sx: {
            width: { xs: "calc(100vw - 32px)", sm: 460 },
            borderRadius: 4,
            border: `1px solid ${alpha(BRAND_PRIMARY, 0.18)}`,
            background: `linear-gradient(180deg, ${alpha(
              "#10191B",
              0.98,
            )} 0%, ${alpha("#0B1115", 0.98)} 100%)`,
            color: "#F4FBF9",
            boxShadow: "0 32px 80px rgba(0, 0, 0, 0.4)",
            backdropFilter: "blur(24px)",
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Typography variant="h5" fontWeight={700} letterSpacing="-0.03em">
            New Project
          </Typography>
        </DialogTitle>

        <DialogContent
          sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}
        >
          <TextField
            autoFocus
            margin="dense"
            label="Project Name"
            fullWidth
            variant="outlined"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            onKeyDown={(event) =>
              event.key === "Enter" && void handleCreateConfirm()
            }
          />

          <Box>
            <Typography
              variant="caption"
              sx={{
                mb: 1,
                display: "block",
                color: alpha("#FFFFFF", 0.58),
                letterSpacing: "0.14em",
              }}
            >
              ASPECT RATIO
            </Typography>
            <ToggleButtonGroup
              value={selectedAspectRatio}
              exclusive
              onChange={(_, value) => value && setSelectedAspectRatio(value)}
              fullWidth
              size="small"
            >
              {ASPECT_RATIO_OPTIONS.map((option) => (
                <ToggleButton
                  key={option.value}
                  value={option.value}
                  sx={{
                    flexDirection: "column",
                    gap: 0.35,
                    py: 1.5,
                    color: "#F4FBF9",
                    borderColor: alpha("#FFFFFF", 0.1),
                    "&.Mui-selected": {
                      backgroundColor: alpha(BRAND_PRIMARY, 0.14),
                      color: "#FFFFFF",
                    },
                  }}
                >
                  <Typography variant="body2" fontWeight={700}>
                    {option.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ color: alpha("#FFFFFF", 0.58) }}
                  >
                    {option.sub}
                  </Typography>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          <Box>
            <Typography
              variant="caption"
              sx={{
                mb: 1,
                display: "block",
                color: alpha("#FFFFFF", 0.58),
                letterSpacing: "0.14em",
              }}
            >
              FRAME RATE
            </Typography>
            <ToggleButtonGroup
              value={selectedFps}
              exclusive
              onChange={(_, value) => value && setSelectedFps(value)}
              fullWidth
              size="small"
            >
              {FPS_OPTIONS.map((option) => (
                <ToggleButton
                  key={option.value}
                  value={option.value}
                  sx={{
                    flexDirection: "column",
                    gap: 0.35,
                    py: 1.5,
                    color: "#F4FBF9",
                    borderColor: alpha("#FFFFFF", 0.1),
                    "&.Mui-selected": {
                      backgroundColor: alpha(BRAND_PRIMARY, 0.14),
                      color: "#FFFFFF",
                    },
                  }}
                >
                  <Typography variant="body2" fontWeight={700}>
                    {option.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ color: alpha("#FFFFFF", 0.58) }}
                  >
                    {option.sub}
                  </Typography>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button
            onClick={() => setCreateOpen(false)}
            sx={{ color: alpha("#FFFFFF", 0.68) }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleCreateConfirm()}
            variant="contained"
            sx={{
              color: "#08110F",
              background: `linear-gradient(135deg, ${BRAND_PRIMARY} 0%, #A5E7DA 100%)`,
              "&:hover": {
                background: `linear-gradient(135deg, #82d9ca 0%, #B5EFE4 100%)`,
              },
            }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {loading && (
        <Box
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(3, 7, 10, 0.62)",
            backdropFilter: "blur(6px)",
          }}
        >
          <CircularProgress sx={{ color: BRAND_PRIMARY }} />
        </Box>
      )}
    </Box>
  );
}
