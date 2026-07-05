export const BRIDGE_PROTOCOL = "vlo-bridge";
export const BRIDGE_VERSION = 2;

export const REQUIRED_BRIDGE_CAPABILITIES = [
  "health",
  "health-changed",
  "read-active",
  "read-pending-warnings",
  "inject-workflow",
  "resolve-prompt",
  "refresh-missing-models",
  "graph-changed",
  "workflow-revision",
  "drop-asset",
] as const;

export type BridgeClientStatus =
  | "unbound"
  | "handshaking"
  | "ready"
  | "incompatible"
  | "unavailable";

export type BridgeErrorCode =
  | "not-bound"
  | "not-ready"
  | "incompatible"
  | "timeout"
  | "iframe-reloaded"
  | "iframe-replaced"
  | "post-message-failed"
  | "invalid-response"
  | "remote-error";

export class IframeBridgeError extends Error {
  readonly code: BridgeErrorCode | string;
  readonly details: unknown;

  constructor(code: BridgeErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = "IframeBridgeError";
    this.code = code;
    this.details = details;
  }
}

export interface BridgeWorkflowSnapshot {
  graphData: Record<string, unknown>;
  filename: string | null;
  isModified: boolean;
  workflowInstanceId: string;
  revision: number;
}

export interface BridgeWarningSummary {
  missingNodeTypes: string[];
  missingModels: string[];
}

export interface BridgeInjectResult {
  warnings: BridgeWarningSummary | null;
  snapshot: BridgeWorkflowSnapshot;
}

export interface BridgeHealth {
  appReady: boolean;
  backendConnected: boolean;
}

export interface BridgeIframeGeneration {
  promptId: string;
  phase: "started" | "progress" | "finished";
  value: number | null;
  max: number | null;
  node: string | null;
}

export interface BridgeResolvedPrompt {
  output: Record<string, unknown>;
  workflow: Record<string, unknown>;
}

export interface BridgeWidgetOverride {
  node_id: string;
  widget: string;
  value?: unknown;
}

export interface BridgeWorkflowExpectation {
  workflowInstanceId: string;
  revision: number;
}

export interface BridgeDropAssetTarget {
  classType: string;
  widget: string;
  /** Widget that must hold a truthy value for the target to accept staged
   * filenames (vloMemory loaders' `disable_in_memory`). */
  requiresTruthyWidget?: string;
}

export interface BridgeDropAssetRequest {
  /** Pointer position relative to the iframe viewport. */
  clientX: number;
  clientY: number;
  /** Staged filename relative to ComfyUI's input directory. */
  filename: string;
  /** Existing-node types whose widget may be retargeted by the drop. */
  targets: BridgeDropAssetTarget[];
  /** Node to create when the drop lands on empty canvas. */
  create: { classType: string; widget: string } | null;
}

export interface BridgeDropAssetResult {
  action: "updated" | "created";
  nodeId: string;
  classType: string;
}

const HELLO_RETRY_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INJECT_REQUEST_TIMEOUT_MS = 20_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: IframeBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeChannelId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `channel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function toSnapshot(value: unknown): BridgeWorkflowSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.graphData) ||
    typeof value.workflowInstanceId !== "string" ||
    typeof value.revision !== "number"
  ) {
    throw new IframeBridgeError(
      "invalid-response",
      "The iframe bridge returned an invalid workflow snapshot",
    );
  }
  return {
    graphData: value.graphData,
    filename: typeof value.filename === "string" ? value.filename : null,
    isModified: value.isModified === true,
    workflowInstanceId: value.workflowInstanceId,
    revision: value.revision,
  };
}

function toIframeGeneration(value: unknown): BridgeIframeGeneration {
  if (
    !isRecord(value) ||
    typeof value.promptId !== "string" ||
    !value.promptId ||
    (value.phase !== "started" &&
      value.phase !== "progress" &&
      value.phase !== "finished")
  ) {
    throw new IframeBridgeError(
      "invalid-response",
      "The iframe bridge returned an invalid iframe-generation event",
    );
  }
  return {
    promptId: value.promptId,
    phase: value.phase,
    value: typeof value.value === "number" ? value.value : null,
    max: typeof value.max === "number" ? value.max : null,
    node: typeof value.node === "string" ? value.node : null,
  };
}

function toWarningSummary(value: unknown): BridgeWarningSummary | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new IframeBridgeError(
      "invalid-response",
      "The iframe bridge returned invalid workflow warnings",
    );
  }
  const missingNodeTypes = Array.isArray(value.missingNodeTypes)
    ? value.missingNodeTypes.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const missingModels = Array.isArray(value.missingModels)
    ? value.missingModels.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  if (missingNodeTypes.length === 0 && missingModels.length === 0) return null;
  return { missingNodeTypes, missingModels };
}

export class IframeBridgeClient {
  private iframe: HTMLIFrameElement | null = null;
  private channelId: string | null = null;
  private status: BridgeClientStatus = "unbound";
  private statusError: IframeBridgeError | null = null;
  private requestCounter = 0;
  private listening = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyHandlers = new Set<() => void>();
  private readonly statusHandlers = new Set<
    (status: BridgeClientStatus, error: IframeBridgeError | null) => void
  >();
  private readonly graphChangedHandlers = new Set<
    (snapshot: BridgeWorkflowSnapshot) => void
  >();
  private readonly healthChangedHandlers = new Set<
    (health: BridgeHealth) => void
  >();
  private readonly iframeGenerationHandlers = new Set<
    (generation: BridgeIframeGeneration) => void
  >();

  get isReady(): boolean {
    return this.status === "ready" && this.iframe !== null;
  }

  get currentStatus(): BridgeClientStatus {
    return this.status;
  }

  get currentError(): IframeBridgeError | null {
    return this.statusError;
  }

  get boundIframe(): HTMLIFrameElement | null {
    return this.iframe;
  }

  bindIframe(iframe: HTMLIFrameElement | null): void {
    if (this.iframe === iframe) return;
    this.rejectAllPending(
      new IframeBridgeError("iframe-replaced", "ComfyUI iframe was replaced"),
    );
    this.iframe = iframe;
    this.ensureListener();
    if (!iframe) {
      this.channelId = null;
      this.setStatus("unbound", null);
      return;
    }
    this.beginHandshake();
  }

  notifyIframeReloaded(): void {
    this.rejectAllPending(
      new IframeBridgeError("iframe-reloaded", "ComfyUI iframe reloaded"),
    );
    if (this.iframe) this.beginHandshake();
  }

  onReady(handler: () => void): () => void {
    this.readyHandlers.add(handler);
    return () => this.readyHandlers.delete(handler);
  }

  onStatusChanged(
    handler: (
      status: BridgeClientStatus,
      error: IframeBridgeError | null,
    ) => void,
  ): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onGraphChanged(
    handler: (snapshot: BridgeWorkflowSnapshot) => void,
  ): () => void {
    this.graphChangedHandlers.add(handler);
    return () => this.graphChangedHandlers.delete(handler);
  }

  onHealthChanged(handler: (health: BridgeHealth) => void): () => void {
    this.healthChangedHandlers.add(handler);
    return () => this.healthChangedHandlers.delete(handler);
  }

  onIframeGeneration(
    handler: (generation: BridgeIframeGeneration) => void,
  ): () => void {
    this.iframeGenerationHandlers.add(handler);
    return () => this.iframeGenerationHandlers.delete(handler);
  }

  async waitForReady(
    timeoutMs: number,
    shouldAbort?: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort?.()) return false;
      if (this.status === "incompatible") throw this.requireStatusError();
      if (this.isReady) return true;
      this.sendHello();
      await new Promise((resolve) => globalThis.setTimeout(resolve, HELLO_RETRY_MS));
    }
    if (this.isReady) return true;
    const error = new IframeBridgeError(
      "timeout",
      "The vlo iframe bridge did not become ready",
    );
    this.setStatus("unavailable", error);
    return false;
  }

  async health(): Promise<BridgeHealth> {
    return this.toHealth(
      await this.request("health", undefined, HEALTH_REQUEST_TIMEOUT_MS),
    );
  }

  async readActive(): Promise<BridgeWorkflowSnapshot | null> {
    const result = await this.request("read-active");
    return result === null ? null : toSnapshot(result);
  }

  async injectWorkflow(
    graphData: Record<string, unknown>,
    filename: string,
  ): Promise<BridgeInjectResult> {
    const result = await this.request(
      "inject-workflow",
      { graphData, filename },
      INJECT_REQUEST_TIMEOUT_MS,
    );
    if (!isRecord(result)) {
      throw new IframeBridgeError(
        "invalid-response",
        "The iframe bridge returned an invalid injection result",
      );
    }
    return {
      warnings: toWarningSummary(result.warnings),
      snapshot: toSnapshot(result.snapshot),
    };
  }

  async resolvePrompt(
    expectation: BridgeWorkflowExpectation,
    bypassNodeIds: string[],
    widgetOverrides: BridgeWidgetOverride[],
  ): Promise<BridgeResolvedPrompt> {
    const result = await this.request("resolve-prompt", {
      ...expectation,
      bypassNodeIds,
      widgetOverrides,
    });
    if (!isRecord(result) || !isRecord(result.output)) {
      throw new IframeBridgeError(
        "invalid-response",
        "The iframe bridge returned an invalid prompt",
      );
    }
    return {
      output: result.output,
      workflow: isRecord(result.workflow) ? result.workflow : {},
    };
  }

  async refreshMissingModels(): Promise<boolean> {
    const result = await this.request("refresh-missing-models");
    return isRecord(result) && result.refreshed === true;
  }

  async dropAsset(request: BridgeDropAssetRequest): Promise<BridgeDropAssetResult> {
    const result = await this.request("drop-asset", request);
    if (
      !isRecord(result) ||
      (result.action !== "updated" && result.action !== "created") ||
      typeof result.nodeId !== "string"
    ) {
      throw new IframeBridgeError(
        "invalid-response",
        "The iframe bridge returned an invalid drop-asset result",
      );
    }
    return {
      action: result.action,
      nodeId: result.nodeId,
      classType: typeof result.classType === "string" ? result.classType : "",
    };
  }

  async readPendingWarnings(): Promise<BridgeWarningSummary | null> {
    return toWarningSummary(await this.request("read-pending-warnings"));
  }

  private beginHandshake(): void {
    this.channelId = makeChannelId();
    this.setStatus("handshaking", null);
    this.sendHello();
  }

  private ensureListener(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("message", this.handleMessage);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    const contentWindow = this.iframe?.contentWindow;
    if (!contentWindow || event.source !== contentWindow) return;
    const data: unknown = event.data;
    if (
      !isRecord(data) ||
      data.protocol !== BRIDGE_PROTOCOL ||
      data.channelId !== this.channelId ||
      typeof data.type !== "string"
    ) {
      return;
    }

    if (data.type === "ready") {
      const capabilities = Array.isArray(data.capabilities)
        ? new Set(data.capabilities.filter((entry): entry is string => typeof entry === "string"))
        : new Set<string>();
      const missingCapabilities = REQUIRED_BRIDGE_CAPABILITIES.filter(
        (capability) => !capabilities.has(capability),
      );
      if (data.version !== BRIDGE_VERSION || missingCapabilities.length > 0) {
        const error = new IframeBridgeError(
          "incompatible",
          data.version !== BRIDGE_VERSION
            ? `Iframe bridge protocol ${String(data.version)} is incompatible with version ${BRIDGE_VERSION}`
            : `Iframe bridge is missing capabilities: ${missingCapabilities.join(", ")}`,
          { receivedVersion: data.version, missingCapabilities },
        );
        this.rejectAllPending(error);
        this.setStatus("incompatible", error);
        return;
      }
      const wasReady = this.isReady;
      this.setStatus("ready", null);
      if (!wasReady) for (const handler of this.readyHandlers) handler();
      return;
    }

    if (data.version !== BRIDGE_VERSION) return;

    if (data.type === "event" && data.event === "graph-changed") {
      try {
        const snapshot = toSnapshot(data.data);
        for (const handler of this.graphChangedHandlers) handler(snapshot);
      } catch (error) {
        console.warn("[iframeBridge] Ignoring invalid graph-changed event", error);
      }
      return;
    }

    if (data.type === "event" && data.event === "health-changed") {
      try {
        const health = this.toHealth(data.data);
        for (const handler of this.healthChangedHandlers) handler(health);
      } catch (error) {
        console.warn("[iframeBridge] Ignoring invalid health-changed event", error);
      }
      return;
    }

    if (data.type === "event" && data.event === "iframe-generation") {
      try {
        const generation = toIframeGeneration(data.data);
        for (const handler of this.iframeGenerationHandlers) handler(generation);
      } catch (error) {
        console.warn(
          "[iframeBridge] Ignoring invalid iframe-generation event",
          error,
        );
      }
      return;
    }

    if (data.type === "response" && typeof data.requestId === "string") {
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      clearTimeout(pending.timer);
      if (data.ok === true) {
        pending.resolve(data.result);
      } else {
        const remote = isRecord(data.error) ? data.error : {};
        pending.reject(
          new IframeBridgeError(
            typeof remote.code === "string" ? remote.code : "remote-error",
            typeof remote.message === "string"
              ? remote.message
              : "The iframe bridge request failed",
            remote.details,
          ),
        );
      }
    }
  };

  private sendHello(): void {
    if (!this.channelId) return;
    this.post({ type: "hello" });
  }

  private post(message: Record<string, unknown>): void {
    const contentWindow = this.iframe?.contentWindow;
    if (!contentWindow || !this.channelId) return;
    try {
      contentWindow.postMessage(
        {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          channelId: this.channelId,
          ...message,
        },
        window.location.origin,
      );
    } catch (error) {
      throw new IframeBridgeError(
        "post-message-failed",
        "Could not send a message to the ComfyUI iframe",
        error,
      );
    }
  }

  private request(
    method: string,
    payload?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.iframe?.contentWindow) {
      return Promise.reject(
        new IframeBridgeError("not-bound", "ComfyUI iframe is not mounted"),
      );
    }
    if (!this.isReady) {
      return Promise.reject(
        this.statusError ??
          new IframeBridgeError("not-ready", "The vlo iframe bridge is not ready"),
      );
    }
    const requestId = `request-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new IframeBridgeError(
            "timeout",
            `Iframe bridge request timed out: ${method}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.post({
          type: "request",
          requestId,
          method,
          ...(payload === undefined ? {} : { payload }),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          error instanceof IframeBridgeError
            ? error
            : new IframeBridgeError("post-message-failed", String(error)),
        );
      }
    });
  }

  private toHealth(value: unknown): BridgeHealth {
    if (!isRecord(value)) {
      throw new IframeBridgeError(
        "invalid-response",
        "The iframe bridge returned invalid health state",
      );
    }
    return {
      appReady: value.appReady === true,
      backendConnected: value.backendConnected === true,
    };
  }

  private setStatus(
    status: BridgeClientStatus,
    error: IframeBridgeError | null,
  ): void {
    if (this.status === status && this.statusError === error) return;
    this.status = status;
    this.statusError = error;
    for (const handler of this.statusHandlers) handler(status, error);
  }

  private requireStatusError(): IframeBridgeError {
    return (
      this.statusError ??
      new IframeBridgeError("incompatible", "The iframe bridge is incompatible")
    );
  }

  private rejectAllPending(reason: IframeBridgeError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

export const iframeBridge = new IframeBridgeClient();
