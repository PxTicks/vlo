import { memo, useSyncExternalStore } from "react";
import {
  Box,
  Typography,
  Select,
  MenuItem,
  FormControl,
} from "@mui/material";
import { hostContextKeys } from "../../../core/shell/contextKeys";
import {
  hostOptionCatalog,
  type CatalogueOptionEntry,
} from "../../../core/shell/optionCatalog";
import type { ControlDefinition } from "../types";
import type { CatalogueSelectionValue } from "../types";

const EMPTY_OPTIONS: readonly CatalogueOptionEntry[] = [];
const CATALOGUE_VALUE_PREFIX = "catalogue:";

function isCatalogueSelectionValue(
  value: unknown,
): value is CatalogueSelectionValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "catalogueId" in value &&
    typeof value.catalogueId === "string" &&
    "optionId" in value &&
    typeof value.optionId === "string" &&
    "value" in value
  );
}

function catalogueViewValue(optionId: string): string {
  return `${CATALOGUE_VALUE_PREFIX}${optionId}`;
}

/**
 * Catalogue-backed options for a select control (plan §3.7). Static-only
 * selects subscribe to nothing; catalogue selects re-render on catalogue and
 * context-key revisions.
 */
function useCatalogueOptions(
  catalogueId: string | undefined,
): readonly CatalogueOptionEntry[] {
  useSyncExternalStore(
    (listener) =>
      catalogueId ? hostOptionCatalog.subscribe(listener) : () => undefined,
    () => (catalogueId ? hostOptionCatalog.getRevision() : 0),
    () => (catalogueId ? hostOptionCatalog.getRevision() : 0),
  );
  useSyncExternalStore(
    (listener) =>
      catalogueId ? hostContextKeys.subscribe(listener) : () => undefined,
    () => (catalogueId ? hostContextKeys.getRevision() : 0),
    () => (catalogueId ? hostContextKeys.getRevision() : 0),
  );
  if (!catalogueId) return EMPTY_OPTIONS;
  return hostOptionCatalog.resolveOptions(catalogueId);
}

interface SelectControlProps {
  control: ControlDefinition;
  value: unknown;
  onCommit: (val: unknown) => void;
  disabled?: boolean;
}

export const SelectControl = memo(function SelectControl({
  control,
  value,
  onCommit,
  disabled,
}: SelectControlProps) {
  const catalogueOptions = useCatalogueOptions(control.catalogueId);
  const effectiveValue = value ?? control.defaultValue ?? "";
  const catalogueSelection = isCatalogueSelectionValue(effectiveValue)
    ? effectiveValue
    : null;
  const viewValue = catalogueSelection
    ? catalogueViewValue(catalogueSelection.optionId)
    : effectiveValue;

  // Persistence fail-closed rule (§3.7): a stored value referencing a
  // missing catalogue option stays visible and selected — never silently
  // remapped — so uninstalling the providing extension is recoverable.
  const isMissingCatalogueValue =
    control.catalogueId !== undefined &&
    catalogueSelection !== null &&
    (catalogueSelection.catalogueId !== control.catalogueId ||
      !catalogueOptions.some(
        (option) => option.id === catalogueSelection.optionId,
      ));

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
          value={viewValue}
          onChange={(event) => {
            const nextValue = event.target.value;
            const staticOption = control.options?.find(
              (option) => Object.is(option.value, nextValue),
            );
            if (staticOption) {
              onCommit(staticOption.value);
              return;
            }
            if (
              typeof nextValue === "string" &&
              nextValue.startsWith(CATALOGUE_VALUE_PREFIX) &&
              control.catalogueId
            ) {
              const optionId = nextValue.slice(CATALOGUE_VALUE_PREFIX.length);
              const option = catalogueOptions.find(
                (candidate) => candidate.id === optionId,
              );
              if (!option) return;
              onCommit({
                catalogueId: control.catalogueId,
                optionId: option.id,
                value: option.value,
              } satisfies CatalogueSelectionValue);
              return;
            }
            onCommit(nextValue);
          }}
          disableUnderline
          disabled={disabled}
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
          {catalogueOptions.map((option) => (
            <MenuItem key={option.id} value={catalogueViewValue(option.id)}>
              {option.label}
            </MenuItem>
          ))}
          {isMissingCatalogueValue ? (
            <MenuItem value={viewValue as string | number} disabled>
              {`Missing: ${catalogueSelection?.optionId ?? "unknown"}`}
            </MenuItem>
          ) : null}
        </Select>
      </FormControl>
    </Box>
  );
});
