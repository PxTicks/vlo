import type { WorkflowWidgetInput } from "../types";

function normalizeWidgetLabel(label: string | undefined): string {
  return label?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function isAspectRatioWidget(widget: WorkflowWidgetInput): boolean {
  return (
    widget.param === "aspect_ratio" ||
    // The panel's own aspect ratio selector, contributed by the aspect ratio
    // pipeline stage rather than by a node widget.
    widget.param === "target_aspect_ratio" ||
    normalizeWidgetLabel(widget.config.label) === "aspect ratio"
  );
}
