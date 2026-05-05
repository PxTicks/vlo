import { Box, Button, Divider, Typography } from "@mui/material";
import { ArrowBack } from "@mui/icons-material";
import type {
  PositionPathParameter,
  SplineParameter,
} from "../types";
import { SplineGraph } from "./SplineEditor";

interface PositionPathDetailViewProps {
  path: PositionPathParameter;
  onBack: () => void;
  onTimingChange: (timing: SplineParameter) => void;
  onRemove: () => void;
  onRerecord: () => void;
}

export function PositionPathDetailView({
  path,
  onBack,
  onTimingChange,
  onRemove,
  onRerecord,
}: PositionPathDetailViewProps) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Button
          size="small"
          startIcon={<ArrowBack fontSize="small" />}
          onClick={onBack}
          sx={{
            textTransform: "none",
            color: "text.secondary",
            px: 0,
            minWidth: 0,
          }}
        >
          Back To Transform
        </Button>
      </Box>

      <Box sx={{ px: 2, display: "flex", flexDirection: "column", gap: 1 }}>
        <Typography variant="subtitle2">Position Path</Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {`${path.controlPoints.length} control point${
            path.controlPoints.length === 1 ? "" : "s"
          }`}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Drag the sprite in the player to add or move a point at the current playhead time.
        </Typography>
      </Box>

      <Box sx={{ px: 2 }}>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mb: 1 }}
        >
          Timing
        </Typography>
        <SplineGraph
          value={path.timing}
          onChange={(nextTiming) => onTimingChange(nextTiming)}
          width={360}
          height={220}
          minTime={0}
          duration={1}
          minY={0}
          maxY={1}
          softMin={0}
          softMax={1}
          constrainMonotoneIncreasing
          lockEndpoints
          allowPointDeletion={false}
        />
      </Box>

      <Box sx={{ px: 2, pb: 2 }}>
        <Divider sx={{ borderColor: "#2a2d33", mb: 2 }} />
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            variant="outlined"
            onClick={onRerecord}
            sx={{ textTransform: "none", flex: 1 }}
          >
            Re-record
          </Button>
          <Button
            variant="outlined"
            color="error"
            onClick={onRemove}
            sx={{ textTransform: "none", flex: 1 }}
          >
            Remove Path
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
