// src/shared/theme/darkTheme.ts
import { createTheme } from "@mui/material/styles";

export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#2196f3", // Editor Blue
    },
    background: {
      default: "#121212",
      paper: "#1e1e1e", // Slightly lighter for panels
    },
  },
  components: {
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: "#1e1e1e",
          borderRight: "1px solid #333",
        },
      },
    },
  },
});
