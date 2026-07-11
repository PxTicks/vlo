import { Box, IconButton, Tab, Tabs, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { ScopesCanvas } from "./ScopesCanvas";
import { useScopeSnapshot } from "./useScopeSnapshot";
import { useScopesStore, type ScopeKind } from "./useScopesStore";

const SCOPES: readonly { value: ScopeKind; label: string }[] = [
  { value: "waveform", label: "Waveform" },
  { value: "parade", label: "Parade" },
  { value: "vectorscope", label: "Vector" },
  { value: "histogram", label: "Histogram" },
];

export function ScopesDock() {
  const open = useScopesStore((state) => state.open);
  const kind = useScopesStore((state) => state.kind);
  const setKind = useScopesStore((state) => state.setKind);
  const setOpen = useScopesStore((state) => state.setOpen);
  const snapshot = useScopeSnapshot(open);
  if (!open) return null;

  return (
    <Box
      role="dialog"
      aria-label="Video scopes"
      sx={{
        position: "fixed",
        right: 352,
        bottom: 292,
        width: 430,
        bgcolor: "#09090b",
        border: "1px solid #3f3f46",
        borderRadius: 1,
        boxShadow: 8,
        overflow: "hidden",
        zIndex: 120,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", borderBottom: "1px solid #27272a" }}>
        <Typography variant="caption" sx={{ px: 1.5, color: "text.secondary" }}>Scopes</Typography>
        <Tabs value={kind} onChange={(_, value: ScopeKind) => setKind(value)} variant="fullWidth" sx={{ flex: 1, minHeight: 34 }}>
          {SCOPES.map((scope) => <Tab key={scope.value} value={scope.value} label={scope.label} sx={{ minHeight: 34, minWidth: 0, px: 0.5, fontSize: "0.68rem" }} />)}
        </Tabs>
        <IconButton size="small" aria-label="Close scopes" onClick={() => setOpen(false)}><CloseIcon fontSize="small" /></IconButton>
      </Box>
      <ScopesCanvas kind={kind} snapshot={snapshot} />
    </Box>
  );
}
