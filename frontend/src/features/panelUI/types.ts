// === Control definition types ===

export type ControlType =
  | "number"
  | "select"
  | "text"
  | "color"
  | "link"
  | "slider"
  | "spacer";

export interface ControlOption {
  label: string;
  value: unknown;
}

export interface ControlDefinition {
  type: ControlType;
  label: string;
  name: string; // Key in the parameters object
  defaultValue?: unknown;
  step?: number;
  options?: ControlOption[]; // For select type
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  valueTransform?: {
    toModel: (viewValue: unknown) => unknown;
    toView: (modelValue: unknown) => unknown;
  };
  supportsSpline?: boolean;
}

// === Layout types ===

export interface LayoutGroup {
  id: string; // The ID of the group (e.g., "position", "scale")
  title: string; // Display title (e.g., "POSITION (PX)")
  columns?: number | string; // Number of columns (int) or grid-template-columns string
  controls: ControlDefinition[];
  showLinkButton?: boolean; // Whether to show a link/unlink button between controls
}

export interface PanelLayoutConfig {
  groups: LayoutGroup[];
}

// Backward-compatible alias
export type TransformationLayoutConfig = PanelLayoutConfig;

// === Render prop interface ===

export interface ControlRenderProps {
  control: ControlDefinition;
  value: unknown;
  onCommit: (value: unknown) => void;
  groupId: string;
}
