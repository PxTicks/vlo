// React is not used in JSX transform mode usually, or if imports are cleaned
import { ThemeProvider, createTheme } from "@mui/material/styles";

// Basic Dark Theme Setup
const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#90caf9",
    },
    background: {
      default: "#2b2b2b",
      paper: "#1e1e1e",
    },
  },
});

import { useProjectStore, ProjectManager } from "../features/project";
import { Suspense, lazy, useEffect } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";

// 1. Lazy load the heavy editor to separate it from the initial bundle
const EditorLayout = lazy(() =>
  import("./layout/EditorLayout").then((module) => ({
    default: module.EditorLayout,
  })),
);

function LoadingScreen() {
  return (
    <Box
      sx={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        color: "text.primary",
        gap: 2,
      }}
    >
      <CircularProgress size={48} />
      <Typography variant="h6" color="text.secondary">
        Loading Editor...
      </Typography>
    </Box>
  );
}

export function App() {
  const project = useProjectStore((state) => state.project);
  const rootHandle = useProjectStore((state) => state.rootHandle);

  // 2. Smart Preloading: Immediately start fetching the editor code in the background
  // This ensures that while the user is picking a project, the heavy editor code is downloading
  useEffect(() => {
    import("./layout/EditorLayout");
  }, []);

  return (
    <ThemeProvider theme={darkTheme}>
      <Suspense fallback={<LoadingScreen />}>
        {!project || !rootHandle ? <ProjectManager /> : <EditorLayout />}
      </Suspense>
    </ThemeProvider>
  );
}
