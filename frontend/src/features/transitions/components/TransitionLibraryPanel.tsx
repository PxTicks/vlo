import { memo } from "react";
import { Box, Typography } from "@mui/material";
import { TransitionRegistry } from "../catalogue/TransitionRegistry";
import { TransitionCard } from "./TransitionCard";

function TransitionLibraryPanelComponent() {
  return (
    <Box
      sx={{
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: "#111",
      }}
    >
      <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid #2a2a2a" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Transitions
        </Typography>
      </Box>
      <Box
        sx={{
          p: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          overflowY: "auto",
        }}
      >
        {TransitionRegistry.map((definition) => (
          <TransitionCard key={definition.type} definition={definition} />
        ))}
      </Box>
    </Box>
  );
}

export const TransitionLibraryPanel = memo(
  TransitionLibraryPanelComponent,
);
