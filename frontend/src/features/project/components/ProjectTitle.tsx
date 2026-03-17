import { useState, type KeyboardEvent } from "react";
import { Typography, TextField, Box } from "@mui/material";
import { useProjectStore } from "../useProjectStore";

export function ProjectTitle() {
  const { project, updateTitle } = useProjectStore();
  const [isEditing, setIsEditing] = useState(false);
  const [tempTitle, setTempTitle] = useState(project?.title || "");

  if (!project) return <Typography>Loading...</Typography>;

  const save = async () => {
    const trimmed = tempTitle.trim();

    // Only trigger update if title actually changed
    if (trimmed && trimmed !== project.title) {
      // This will now trigger the API call and folder rename
      await updateTitle(trimmed);
    } else {
      setTempTitle(project.title);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      save();
      // Remove focus to hide keyboard / submit visually
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === "Escape") {
      setTempTitle(project.title);
      setIsEditing(false);
    }
  };

  return (
    <Box sx={{ minWidth: 200, textAlign: "center" }}>
      {isEditing ? (
        <TextField
          fullWidth
          variant="standard"
          value={tempTitle}
          autoFocus
          onBlur={save}
          onChange={(e) => setTempTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          slotProps={{
            input: {
              disableUnderline: true,
              sx: {
                fontSize: "1.25rem",
                fontWeight: 500,
                color: "white",
                p: 0,
                textAlign: "center",
              },
            },
          }}
          sx={{
            "& .MuiInputBase-root": {
              justifyContent: "center",
            },
          }}
        />
      ) : (
        <Typography
          variant="h6"
          onClick={() => {
            setTempTitle(project.title); // Sync before editing
            setIsEditing(true);
          }}
          sx={{
            cursor: "text",
            px: 1,
            borderRadius: 1,
            "&:hover": { bgcolor: "rgba(255,255,255, 0.1)" },
          }}
        >
          {project.title}
        </Typography>
      )}
    </Box>
  );
}
