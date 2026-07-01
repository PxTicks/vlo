import { useSyncExternalStore, type ComponentType } from "react";
import { Alert, AlertTitle, Box, Chip, Tooltip } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import type {
  ExtensionUiComponentProps,
  ExtensionUiNoticeTone,
  ExtensionUiSlotId,
} from "../types";
import {
  extensionUiSlotRegistry,
  type RegisteredExtensionUiContribution,
} from "./ExtensionUiSlotRegistry";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";

export interface ExtensionUiSlotProps {
  readonly slot: ExtensionUiSlotId;
  readonly presentation?: "stack" | "inline";
}

const NOTICE_TONE: Record<
  ExtensionUiNoticeTone,
  { readonly color: "info" | "success" | "warning"; readonly Icon: typeof InfoOutlinedIcon }
> = {
  info: { color: "info", Icon: InfoOutlinedIcon },
  success: { color: "success", Icon: CheckCircleOutlineIcon },
  warning: { color: "warning", Icon: WarningAmberIcon },
};

/**
 * Compact single-line notice for inline slots (e.g. the 40px timeline/generation
 * toolbars), where a full stacked `<Alert>` would overflow. The title stays
 * visible; the message is surfaced on hover so no information is lost.
 */
function InlineNotice({
  title,
  message,
  tone,
}: {
  readonly title: string;
  readonly message: string;
  readonly tone: ExtensionUiNoticeTone;
}) {
  const { color, Icon } = NOTICE_TONE[tone];
  return (
    <Tooltip title={message}>
      <Chip
        size="small"
        color={color}
        variant="outlined"
        icon={<Icon fontSize="small" />}
        label={title}
        sx={{ maxWidth: 220, height: 24 }}
      />
    </Tooltip>
  );
}

function TrustedExtensionComponent({
  contribution,
}: {
  readonly contribution: RegisteredExtensionUiContribution;
}) {
  if (contribution.definition.kind !== "trusted-react") return null;
  const component = contribution.definition.component as ComponentType<
    ExtensionUiComponentProps
  >;
  return (
    <ExtensionTrustedReactMount
      contributionId={contribution.id}
      surface="UI contribution"
      report={contribution.definition.report}
      component={component}
      componentProps={{ slot: contribution.definition.slot }}
    />
  );
}

export function ExtensionUiSlot({
  slot,
  presentation = "stack",
}: ExtensionUiSlotProps) {
  useSyncExternalStore(
    (listener) => extensionUiSlotRegistry.subscribe(listener),
    () => extensionUiSlotRegistry.getRevision(),
    () => extensionUiSlotRegistry.getRevision(),
  );
  const contributions = extensionUiSlotRegistry.list(slot);
  if (contributions.length === 0) return null;

  return (
    <Box
      data-testid={`extension-ui-slot-${slot}`}
      sx={
        presentation === "inline"
          ? { display: "flex", alignItems: "center", gap: 1 }
          : { px: 1, pt: 1 }
      }
    >
      {contributions.map((contribution) =>
        contribution.definition.kind === "notice" ? (
          <Box
            key={contribution.id}
            data-testid={`extension-ui-contribution-${contribution.id}`}
            sx={presentation === "stack" ? { mb: 1 } : undefined}
          >
            {presentation === "inline" ? (
              <InlineNotice
                title={contribution.definition.title}
                message={contribution.definition.message}
                tone={contribution.definition.tone}
              />
            ) : (
              <Alert severity={contribution.definition.tone}>
                <AlertTitle>{contribution.definition.title}</AlertTitle>
                {contribution.definition.message}
              </Alert>
            )}
          </Box>
        ) : contribution.definition.kind === "trusted-react" ? (
          <Box
            key={contribution.id}
            data-testid={`extension-ui-contribution-${contribution.id}`}
            sx={presentation === "stack" ? { mb: 1 } : undefined}
          >
            <TrustedExtensionComponent contribution={contribution} />
          </Box>
        ) : null,
      )}
    </Box>
  );
}
