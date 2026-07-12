import { useId, type ReactNode } from "react";
import { Box, Tab, Tabs } from "@mui/material";

export interface PanelTabDefinition<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
  readonly disabled?: boolean;
}

interface PanelTabsProps<TValue extends string> {
  readonly ariaLabel: string;
  readonly tabs: readonly PanelTabDefinition<TValue>[];
  readonly value: TValue;
  readonly onChange: (value: TValue) => void;
  readonly children: ReactNode;
}

export function PanelTabs<TValue extends string>({
  ariaLabel,
  tabs,
  value,
  onChange,
  children,
}: PanelTabsProps<TValue>) {
  const id = useId();

  return (
    <>
      <Tabs
        value={value}
        onChange={(_, nextValue: TValue) => onChange(nextValue)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label={ariaLabel}
        sx={{
          minHeight: 36,
          borderBottom: 1,
          borderColor: "divider",
          "& .MuiTab-root": {
            minHeight: 36,
            minWidth: "auto",
            px: 1.5,
            py: 0.75,
            fontSize: "0.72rem",
            textTransform: "none",
          },
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.value}
            id={`${id}-${tab.value}-tab`}
            aria-controls={`${id}-${tab.value}-panel`}
            value={tab.value}
            label={tab.label}
            disabled={tab.disabled}
          />
        ))}
      </Tabs>
      <Box
        id={`${id}-${value}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${value}-tab`}
      >
        {children}
      </Box>
    </>
  );
}
