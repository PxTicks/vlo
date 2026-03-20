import type {
  WorkflowInput,
  WorkflowManualSlotSelectionConfig,
  WorkflowParamReference,
  WorkflowRuleSlotInputType,
  WidgetValueType,
} from "../../types";
import { isRecord } from "../parsers";
import type {
  WorkflowRuleSelectionConfig,
  WorkflowRuleWarning,
} from "./types";

export function toStringRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function toRulesWarning(
  code: string,
  message: string,
  nodeId?: string,
): WorkflowRuleWarning {
  return nodeId ? { code, message, node_id: nodeId } : { code, message };
}

export function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.round(value);
  return normalized > 0 ? normalized : null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeParamReference(
  value: unknown,
): WorkflowParamReference | null {
  if (!isRecord(value)) return null;
  if (typeof value.node_id !== "string" || typeof value.param !== "string") {
    return null;
  }
  const nodeId = value.node_id.trim();
  const param = value.param.trim();
  if (!nodeId || !param) return null;
  return {
    nodeId,
    param,
  };
}

const SUPPORTED_WIDGET_VALUE_TYPES: readonly WidgetValueType[] = [
  "int",
  "float",
  "string",
  "boolean",
  "enum",
  "unknown",
];

export function toWidgetValueType(value: unknown): WidgetValueType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as WidgetValueType;
  return SUPPORTED_WIDGET_VALUE_TYPES.includes(normalized)
    ? normalized
    : undefined;
}

export function toWidgetOptions(
  value: unknown,
): Array<string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.filter(
    (item): item is string | number | boolean =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean",
  );
  return options.length > 0 ? options : undefined;
}

export function toWorkflowInputType(
  value: string,
): WorkflowInput["inputType"] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text") return "text";
  if (normalized === "image") return "image";
  if (normalized === "video") return "video";
  return null;
}

export function toSlotInputType(
  value: string,
): {
  uiInputType: WorkflowInput["inputType"];
  slotInputType: WorkflowRuleSlotInputType;
} | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text") {
    return { uiInputType: "text", slotInputType: "text" };
  }
  if (normalized === "image") {
    return { uiInputType: "image", slotInputType: "image" };
  }
  if (normalized === "video") {
    return { uiInputType: "video", slotInputType: "video" };
  }
  if (normalized === "audio") {
    // Audio slots use a video source in the UI so preprocessing can extract audio.
    return { uiInputType: "video", slotInputType: "audio" };
  }
  return null;
}

export function toSelectionConfig(
  selection: WorkflowRuleSelectionConfig | undefined,
): WorkflowManualSlotSelectionConfig | undefined {
  if (!selection) return undefined;

  const next: WorkflowManualSlotSelectionConfig = {};
  if (typeof selection.export_fps === "number" && selection.export_fps > 0) {
    next.exportFps = selection.export_fps;
  }
  if (typeof selection.frame_step === "number" && selection.frame_step > 0) {
    next.frameStep = selection.frame_step;
  }
  if (typeof selection.max_frames === "number" && selection.max_frames > 0) {
    next.maxFrames = selection.max_frames;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}
