import { registerCustomControl } from "../../panelUI";
import {
  EXTENSION_PANEL_CONTROL_ZONE_ID,
  ExtensionPanelControlZone,
} from "./ExtensionPanelControlZone";

let registered = false;

/**
 * Host-owned controls share the same custom-control lookup as extension
 * contributions, but register under a reserved host ID rather than pretending to
 * be activation-scoped third-party contributions.
 */
export function registerHostPanelControls(): void {
  if (registered) return;
  registered = true;
  registerCustomControl(EXTENSION_PANEL_CONTROL_ZONE_ID, ExtensionPanelControlZone);
}
