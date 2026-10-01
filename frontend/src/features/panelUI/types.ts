import type { JsonValue } from "@vlo/extension-sdk";
import type { ComponentType, ReactNode } from "react";

// === Control definition types ===

export type ControlType =
  | "number"
  | "select"
  | "checkbox"
  | "text"
  | "richtext"
  | "color"
  | "link"
  | "slider"
  | "custom"
  | "spacer";

export interface ControlOption {
  label: string;
  value: unknown;
}

/** Persisted, provider-independent snapshot of one catalogue selection. */
export interface CatalogueSelectionValue {
  readonly catalogueId: string;
  readonly optionId: string;
  readonly value: JsonValue;
}

export interface ControlDefinition {
  type: ControlType;
  label: string;
  name: string; // Key in the parameters object
  hidden?: boolean;
  defaultValue?: unknown;
  step?: number;
  options?: ControlOption[]; // For select type
  /**
   * For select type: also render the options of this host option catalogue
   * (extension-shell-surfaces plan §3.7). Catalogue options commit their
   * `{ catalogueId, optionId, value }`; a stored option whose provider is
   * missing renders as a disabled "Missing" entry preserving that snapshot.
   */
  catalogueId?: string;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  valueTransform?: {
    toModel: (viewValue: unknown) => unknown;
    toView: (modelValue: unknown) => unknown;
  };
  supportsSpline?: boolean;
  /** Registered rich-control component. Only used when `type` is `custom`. */
  componentId?: string;
  /**
   * Parameters a rich control is allowed to commit. Only used when `type` is
   * `custom`; omitted means the owning transformation's whole parameter set.
   */
  parameterNames?: readonly string[];
  /** JSON-like component configuration owned by the registered control. */
  config?: Readonly<Record<string, unknown>>;
}

// === Layout types ===

export interface LayoutGroup {
  id: string; // The ID of the group (e.g., "position", "scale")
  title: string; // Display title (e.g., "POSITION (PX)")
  columns?: number | string; // Number of columns (int) or grid-template-columns string
  controls: readonly ControlDefinition[];
  showLinkButton?: boolean; // Whether to show a link/unlink button between controls
}

export interface PanelLayoutConfig {
  groups: readonly LayoutGroup[];
}

// Backward-compatible alias
export type TransformationLayoutConfig = PanelLayoutConfig;

// === Render prop interface ===

export interface ControlRenderProps {
  control: ControlDefinition;
  value: unknown;
  values: Readonly<Record<string, unknown>>;
  onCommit: (value: unknown) => void;
  onCommitMany: (values: Readonly<Record<string, unknown>>) => void;
  groupId: string;
  transformId?: string;
  disabled?: boolean;
}

export interface CustomControlRenderProps extends ControlRenderProps {
  /** Source-media time domain for controls that transfer animated values. */
  sourceTimeRange?: {
    readonly minTime: number;
    readonly duration: number;
  };
  /** Render a hidden scalar parameter with the host's standard animation UI. */
  renderParameterControl?: (control: ControlDefinition) => ReactNode;
}

export type CustomControlComponent = ComponentType<CustomControlRenderProps>;
