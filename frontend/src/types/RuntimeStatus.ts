export type BackendRuntimeStatus = "ok";
export type ComfyUiRuntimeStatus =
  | "connected"
  | "disconnected"
  | "invalid_config";
export type Sam2RuntimeStatus = "available" | "unavailable";
export type SamAudioRuntimeStatus = "available" | "unavailable";
export type WorkflowMode = "default" | "high_vram";
export type HighVramPromptStatus = "accepted" | "declined";
export type ComfyuiInstallDirPromptStatus = "accepted" | "declined";

export interface ComfyuiInstallVerification {
  requestedPath: string;
  installPath: string | null;
  valid: boolean;
  mainPyPresent: boolean;
  sourceMarkers: string[];
  layoutMarkers: string[];
  warnings: string[];
}

export interface RuntimeSettings {
  workflowMode: WorkflowMode;
  comfyuiUrl: string;
  comfyuiInstallDir: string | null;
  comfyuiInstallVerification: ComfyuiInstallVerification | null;
  highVramPromptStatus: HighVramPromptStatus | null;
  comfyuiInstallDirPromptStatus: ComfyuiInstallDirPromptStatus | null;
}

export interface RuntimeHardware {
  vram: {
    totalMb: number | null;
    source: "comfyui" | "nvidia_smi" | null;
    meetsHighVramThreshold: boolean;
  };
  highVramThresholdMb: number;
}

export interface RuntimeRecommendations {
  shouldPromptForHighVram: boolean;
  shouldPromptForComfyuiInstallDir: boolean;
}

export interface RuntimeSettingsPayload {
  settings: RuntimeSettings;
  hardware: RuntimeHardware;
  recommendations: RuntimeRecommendations;
}

export interface RuntimeSettingsPatch {
  workflowMode?: WorkflowMode;
  comfyuiUrl?: string;
  comfyuiInstallDir?: string | null;
  allowUnverifiedComfyuiInstallDir?: boolean;
  highVramPromptStatus?: HighVramPromptStatus;
  comfyuiInstallDirPromptStatus?: ComfyuiInstallDirPromptStatus;
}

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
    modelDownloadsEnabled?: boolean;
  };
  settings?: RuntimeSettings;
  hardware?: RuntimeHardware;
  recommendations?: RuntimeRecommendations;
  sam2: {
    status: Sam2RuntimeStatus;
    error: string | null;
  };
  sam_audio?: {
    status: SamAudioRuntimeStatus;
    error: string | null;
  };
}
