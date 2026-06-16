import { memo, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import { getAddableTransforms } from "../../catalogue/TransformationRegistry";
import { TransformationCard } from "./TransformationCard";

function TransformationLibraryPanelComponent() {
  const definitions = useMemo(
    () =>
      getAddableTransforms().filter(
        (definition) => definition.compatibleClips !== "mask",
      ),
    [],
  );

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
      <Box
        sx={{
          flexShrink: 0,
          px: 2,
          py: 1.5,
          borderBottom: "1px solid #2a2a2a",
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Effects
        </Typography>
      </Box>

      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: "auto",
          p: 1.5,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {definitions.map((definition) => (
          <TransformationCard
            key={definition.filterName ?? definition.type}
            definition={definition}
          />
        ))}
      </Box>
    </Box>
  );
}

export const TransformationLibraryPanel = memo(
  TransformationLibraryPanelComponent,
);
