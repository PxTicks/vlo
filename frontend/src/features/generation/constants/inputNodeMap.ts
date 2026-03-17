import type { WorkflowInput } from "../types";

export interface InputNodeMapEntry {
  inputType: WorkflowInput["inputType"];
  param: string;
}

// Keep this in sync with backend/routers/comfyui.py INPUT_NODE_MAP.
export const INPUT_NODE_MAP: Record<string, InputNodeMapEntry> = {
  LoadImage: { inputType: "image", param: "image" },
  CLIPTextEncode: { inputType: "text", param: "text" },
  LoadVideo: { inputType: "video", param: "file" },
  VHS_LoadVideo: { inputType: "video", param: "video" },
};
