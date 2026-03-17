export type BackendRuntimeStatus = "ok";
export type ComfyUiRuntimeStatus =
  | "connected"
  | "disconnected"
  | "invalid_config";
export type Sam2RuntimeStatus = "available" | "unavailable";

export interface RuntimeStatus {
  backend: {
    status: BackendRuntimeStatus;
    mode: "development" | "production";
    frontendBuildPresent: boolean;
  };
  comfyui: {
    status: ComfyUiRuntimeStatus;
    url: string;
    error: string | null;
  };
  sam2: {
    status: Sam2RuntimeStatus;
    error: string | null;
  };
}
