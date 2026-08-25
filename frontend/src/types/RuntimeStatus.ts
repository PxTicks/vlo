export type BackendRuntimeStatus = "ok";
export type ComfyUiRuntimeStatus =
  | "connected"
  | "disconnected"
  | "invalid_config";
/** @deprecated Use {@link RuntimeCapability} and its `canAttempt` field. */
export type Sam2RuntimeStatus = "available" | "unavailable";
/** @deprecated Use {@link RuntimeCapability} and its `canAttempt` field. */
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

/**
 * The two-state field `/app/status` still reports, plus how far the evidence
 * actually reaches — that route never spawns a probe, so `available` can mean
 * "nothing known to be wrong" rather than "checked and fine".
 *
 * @deprecated Read {@link RuntimeCapability} from `/app/runtime-capabilities`.
 */
export interface LegacyCapabilityStatus {
  status: "available" | "unavailable";
  error: string | null;
  state?: CapabilityState;
  verifiedThrough?: CapabilityVerificationStage | null;
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
  sam2: LegacyCapabilityStatus;
  sam_audio?: LegacyCapabilityStatus;
  beat_this?: LegacyCapabilityStatus;
}


// ── Runtime capabilities ─────────────────────────────────────────────────
//
// The staged view of whether a local AI feature can actually run. Mirrors
// backend/services/ai_models/capabilities/contract.py; the two must be
// changed together.

/**
 * Every failure the backend can report. Closed on purpose: an unrecognised
 * runtime failure is classified as `runtime_load_failed` rather than given a
 * new code, so a switch over this union stays total.
 */
export type CapabilityFailureCode =
  | "python_version_unsupported"
  | "package_missing"
  | "package_import_failed"
  | "dependency_incompatible"
  | "dependency_download_failed"
  | "model_missing"
  | "model_invalid"
  | "config_missing"
  | "out_of_memory"
  | "runtime_load_failed"
  | "device_unavailable"
  | "cache_unwritable"
  | "authentication_required";

export type CapabilityState =
  | "unavailable"
  | "blocked"
  | "available_unverified"
  | "ready"
  | "degraded"
  | "checking";

/** How far the evidence reaches. `null` means not even discovery passed. */
export type CapabilityVerificationStage =
  | "discovered"
  | "environment"
  | "loaded"
  | "operational";

/** `skipped` means the check could not be carried out — never that it passed. */
export type CapabilityCheckStatus = "pass" | "warn" | "fail" | "skipped";

export type CapabilityRemediationKind =
  | "command"
  | "download"
  | "settings"
  | "docs";

export interface CapabilityRemediation {
  kind: CapabilityRemediationKind;
  summary: string;
  command?: string;
  url?: string;
  requiresRestart: boolean;
}

export interface CapabilityCheck {
  id: string;
  status: CapabilityCheckStatus;
  stage: CapabilityVerificationStage;
  summary: string;
  code?: CapabilityFailureCode;
  detail?: string;
  remediation?: CapabilityRemediation;
}

export interface CapabilityDevice {
  requested: string;
  resolved: string | null;
  /** False while `resolved` is only what this configuration should resolve to. */
  proven: boolean;
  fallback: boolean;
}

export interface CapabilityFailureRecord {
  code: CapabilityFailureCode;
  summary: string;
  stage: CapabilityVerificationStage;
  occurredAt: string;
  detail?: string;
}

export interface RuntimeCapability {
  id: string;
  label: string;
  state: CapabilityState;
  /** The single field feature surfaces gate on. */
  canAttempt: boolean;
  verifiedThrough: CapabilityVerificationStage | null;
  checkedAt: string;
  selectedModel: string | null;
  device: CapabilityDevice | null;
  models: Record<string, unknown>[];
  checks: CapabilityCheck[];
  lastFailure: CapabilityFailureRecord | null;
  /** Present after this backend process has loaded the runtime successfully. */
  lastSuccessfulLoad?: string | null;
}

export type RuntimeCapabilityProbeStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeCapabilityProbeJob {
  jobId: string;
  jobType: string;
  status: RuntimeCapabilityProbeStatus;
  progress: number;
  message: string;
  error?: string;
  result?: {
    capabilityId: string;
    loaded: boolean;
    details: Record<string, unknown>;
  };
}

export interface RuntimeEnvironmentSnapshot {
  /** The snapshot's own time. Capabilities carry theirs separately. */
  checkedAt: string;
  python: {
    executable: string;
    version: string;
    implementation: string;
    prefix: string;
    virtualEnv: boolean;
  };
  platform: { system: string; release: string; machine: string };
  torch: {
    torchVersion: string | null;
    cudaAvailable: boolean;
    cudaBuildVersion: string | null;
    mpsAvailable: boolean;
    devices: { index: number; name: string; totalMemoryMb: number }[];
    error: string | null;
  } | null;
  probe: { ok: boolean; timedOut: boolean; error: string | null };
  packages: Record<string, string | null>;
  directories: {
    id: string;
    path: string;
    exists: boolean;
    readable: boolean;
    writable: boolean;
  }[];
  searchPaths: Record<string, string[]>;
  huggingFace: { tokenPresent: boolean; tokenSource: string | null };
  offline: { hfHubOffline: boolean; transformersOffline: boolean };
}

export interface RuntimeCapabilitiesPayload {
  capabilities: RuntimeCapability[];
  environment: RuntimeEnvironmentSnapshot;
}

/**
 * One capability, in the listing's envelope. The environment travels with it
 * because a recheck drops the shared device probe as well.
 */
export interface RuntimeCapabilityPayload {
  capability: RuntimeCapability;
  environment: RuntimeEnvironmentSnapshot;
}

export const RUNTIME_CAPABILITY_IDS = {
  sam2: "sam2",
  samAudio: "sam-audio",
  beatThis: "beat-this",
  comfyui: "comfyui",
} as const;

export type RuntimeCapabilityId =
  (typeof RUNTIME_CAPABILITY_IDS)[keyof typeof RUNTIME_CAPABILITY_IDS];
