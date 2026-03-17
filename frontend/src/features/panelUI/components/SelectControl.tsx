import { memo } from "react";
import {
  Box,
  Typography,
  Select,
  MenuItem,
  FormControl,
} from "@mui/material";
import type { ControlDefinition } from "../types";

interface SelectControlProps {
  control: ControlDefinition;
  value: unknown;
  onCommit: (val: unknown) => void;
}

export const SelectControl = memo(function SelectControl({
  control,
  value,
  onCommit,
}: SelectControlProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        px: 1,
        py: 0.5,
      }}
    >
      <Typography variant="caption" sx={{ color: "text.secondary", mb: 0.5 }}>
        {control.label}
      </Typography>
      <FormControl size="small" variant="standard" fullWidth>
        <Select
          value={value ?? control.defaultValue ?? ""}
          onChange={(e) => onCommit(e.target.value)}
          disableUnderline
          sx={{
            "& .MuiSelect-select": {
              py: 0.5,
              fontSize: "0.875rem",
            },
          }}
        >
          {control.options?.map((opt) => (
            <MenuItem
              key={String(opt.value)}
              value={opt.value as string | number}
            >
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  );
});
