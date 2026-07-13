import { useMemo, useSyncExternalStore } from "react";
import { Box, Typography } from "@mui/material";
import type { CustomControlRenderProps } from "../../panelUI";
import {
  extensionPanelControlRegistry,
  type RegisteredExtensionPanelControl,
  type RuntimePanelControlPlacement,
} from "./ExtensionPanelControlRegistry";
import { ExtensionPanelControlMount } from "./ExtensionPanelControlHost";
import type { ExtensionPanelControlPlacement } from "../types";

export { EXTENSION_PANEL_CONTROL_ZONE_ID } from "./panelControlZoneId";

function readTarget(
  config: Readonly<Record<string, unknown>> | undefined,
): ExtensionPanelControlPlacement["target"] | null {
  const filterName = config?.filterName;
  const zone = config?.zone;
  if (typeof filterName !== "string" || typeof zone !== "string") return null;
  return { kind: "filter", filterName, zone };
}

function subscribe(listener: () => void): () => void {
  return extensionPanelControlRegistry.subscribe(listener);
}

function getRevision(): number {
  return extensionPanelControlRegistry.getRevision();
}

/**
 * A host panel zone. Renders nothing until an extension places a control here,
 * so a panel with no extensions installed shows no extra chrome, and the zone
 * empties cleanly when the last contribution is disposed.
 *
 * The zone reads its target and commit allowlist from the host control
 * definition that declares it, so any filter can open a zone without new code.
 */
export function ExtensionPanelControlZone(props: CustomControlRenderProps) {
  const revision = useSyncExternalStore(subscribe, getRevision, getRevision);
  const target = useMemo(() => readTarget(props.control.config), [props.control.config]);

  const entries = useMemo<
    readonly {
      readonly contribution: RegisteredExtensionPanelControl;
      readonly placement: RuntimePanelControlPlacement;
    }[]
  >(() => {
    if (!target) return [];
    return extensionPanelControlRegistry.list(target);
    // `revision` is the store's change signal; the list is recomputed on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, revision]);

  if (entries.length === 0) return null;

  return (
    <Box sx={{ display: "grid", gap: 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {props.control.label || "Extensions"}
      </Typography>
      {entries.map(({ contribution, placement }) => (
        <ExtensionPanelControlMount
          key={contribution.id}
          contributionId={contribution.id}
          component={contribution.definition.component}
          report={contribution.definition.report}
          config={placement.config}
          allowedParameterNames={props.control.parameterNames}
          values={props.values}
          transformId={props.transformId}
          disabled={props.disabled ?? false}
          sourceTimeRange={props.sourceTimeRange}
          onCommitMany={props.onCommitMany}
        />
      ))}
    </Box>
  );
}
