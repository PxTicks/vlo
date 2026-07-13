/**
 * Host control that renders every extension contribution placed in one panel
 * zone. Kept free of React so filter definitions on the render path can declare
 * a zone without importing panel UI.
 */
export const EXTENSION_PANEL_CONTROL_ZONE_ID = "host.extension-panel-zone";
