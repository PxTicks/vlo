import { memo } from "react";
import { IconButton } from "@mui/material";
import { Link, LinkOff } from "@mui/icons-material";

interface LinkControlProps {
  value: unknown;
  onCommit: (val: unknown) => void;
}

export const LinkControl = memo(function LinkControl({
  value,
  onCommit,
}: LinkControlProps) {
  const isLinked = Boolean(value);
  return (
    <IconButton
      size="small"
      onClick={() => onCommit(!isLinked)}
      color={isLinked ? "primary" : "default"}
      sx={{
        transform: "rotate(90deg)",
        padding: 0,
      }}
    >
      {isLinked ? <Link fontSize="small" /> : <LinkOff fontSize="small" />}
    </IconButton>
  );
});
