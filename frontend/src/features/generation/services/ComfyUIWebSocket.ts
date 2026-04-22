export interface ComfyUIStatusEvent {
  type: "status";
  data: { status: { exec_info: { queue_remaining: number } }; sid?: string };
}

export interface ComfyUIProgressEvent {
  type: "progress";
  data: { value: number; max: number; prompt_id: string; node: string };
}

export interface ComfyUIExecutionStartEvent {
  type: "execution_start";
  data: { prompt_id: string };
}

export interface ComfyUIExecutionCachedEvent {
  type: "execution_cached";
  data: { prompt_id: string; nodes: string[] };
}

export interface ComfyUIExecutionSuccessEvent {
  type: "execution_success";
  data: { prompt_id: string; timestamp: number };
}

export interface ComfyUIExecutingEvent {
  type: "executing";
  data: { node: string | null; display_node?: string; prompt_id: string };
}

export interface ComfyUIExecutedEvent {
  type: "executed";
  data: {
    node: string;
    display_node?: string;
    prompt_id: string;
    output: {
      images?: Array<{ filename: string; subfolder: string; type: string }>;
      gifs?: Array<{ filename: string; subfolder: string; type: string }>;
      videos?: Array<{ filename: string; subfolder: string; type: string }>;
    };
  };
}

export interface ComfyUIExecutionErrorEvent {
  type: "execution_error";
  data: {
    prompt_id: string;
    node_id: string;
    node_type: string;
    exception_message: string;
    exception_type: string;
    traceback: string[];
  };
}

export interface ComfyUIExecutionInterruptedEvent {
  type: "execution_interrupted";
  data: {
    prompt_id: string;
    node_id: string;
    node_type: string;
    executed: string[];
  };
}

export interface ComfyUIProxyErrorEvent {
  type: "error";
  data: { message: string };
}

interface ComfyUIFeatureFlagsEvent {
  type: "feature_flags";
  data: Record<string, unknown>;
}

interface ComfyUIVhsLatentPreviewEvent {
  type: "VHS_latentpreview";
  data: { length: number; rate: number; id: string };
}

export type ComfyUIEvent =
  | ComfyUIStatusEvent
  | ComfyUIProgressEvent
  | ComfyUIExecutionStartEvent
  | ComfyUIExecutionCachedEvent
  | ComfyUIExecutionSuccessEvent
  | ComfyUIExecutingEvent
  | ComfyUIExecutedEvent
  | ComfyUIExecutionErrorEvent
  | ComfyUIExecutionInterruptedEvent
  | ComfyUIProxyErrorEvent;

import {
  parseBinaryPreviewPayload,
  type ParsedBinaryPreview,
  type PreviewSequenceMetadata,
} from "./previewBinary";

const PREVIEW_METADATA_FEATURE_FLAGS = JSON.stringify({
  type: "feature_flags",
  data: {
    supports_preview_metadata: true,
  },
});

export type ComfyUIPreview = ParsedBinaryPreview;

export type ComfyUIConnectionState = "connected" | "disconnected";
export type ComfyUIEventHandler = (event: ComfyUIEvent) => void;
export type ComfyUIPreviewHandler = (preview: ComfyUIPreview) => void;
export type ComfyUIConnectionChangeHandler = (
  state: ComfyUIConnectionState,
) => void;

export class ComfyUIWebSocket {
  private ws: WebSocket | null = null;
  private readonly clientId: string;
  private readonly baseUrl: string;
  private eventHandlers = new Set<ComfyUIEventHandler>();
  private previewHandlers = new Set<ComfyUIPreviewHandler>();
  private connectionChangeHandlers = new Set<ComfyUIConnectionChangeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly previewSequenceMetadataByNodeId = new Map<
    string,
    PreviewSequenceMetadata
  >();

  constructor(baseUrl: string) {
    this.clientId = crypto.randomUUID();
    this.baseUrl = baseUrl;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentClientId(): string {
    return this.clientId;
  }

  connect(): void {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.shouldReconnect = true;

    // Build an absolute WebSocket URL from the path-based baseUrl.
    // This ensures the WS connection routes through the same proxy as HTTP requests.
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}${this.baseUrl}/comfy/ws?clientId=${this.clientId}`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.ws?.send(PREVIEW_METADATA_FEATURE_FLAGS);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyConnectionChange("connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else {
        this.handleTextMessage(event.data as string);
      }
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        // Don't notify disconnected during reconnect cycles — avoids flickering
        // between error/disconnected states. Status stays as-is (error/connecting).
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      } else {
        this.notifyConnectionChange("disconnected");
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this, triggering reconnect + disconnect notification
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  onEvent(handler: ComfyUIEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onPreview(handler: ComfyUIPreviewHandler): () => void {
    this.previewHandlers.add(handler);
    return () => {
      this.previewHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: ComfyUIConnectionChangeHandler): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  private handleTextMessage(data: string): void {
    try {
      const event = JSON.parse(data) as
        | ComfyUIEvent
        | ComfyUIFeatureFlagsEvent
        | ComfyUIVhsLatentPreviewEvent;

      if (this.isVhsLatentPreviewEvent(event)) {
        this.previewSequenceMetadataByNodeId.set(event.data.id, {
          frameRate: event.data.rate,
          nodeId: event.data.id,
          totalFrames: event.data.length,
        });
        return;
      }

      if (!this.isComfyUIEvent(event)) {
        return;
      }

      for (const handler of this.eventHandlers) {
        handler(event);
      }
    } catch {
      // ignore unparseable messages (e.g. feature_flags)
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    const parsed = parseBinaryPreviewPayload(data, (nodeId) =>
      this.findPreviewSequenceMetadata(nodeId),
    );
    if (!parsed) return;

    for (const handler of this.previewHandlers) {
      handler(parsed);
    }
  }

  private findPreviewSequenceMetadata(
    nodeId: string,
  ): PreviewSequenceMetadata | null {
    const exactMatch = this.previewSequenceMetadataByNodeId.get(nodeId);
    if (exactMatch) {
      return exactMatch;
    }

    for (const [knownNodeId, metadata] of this.previewSequenceMetadataByNodeId) {
      if (knownNodeId.startsWith(nodeId) || nodeId.startsWith(knownNodeId)) {
        return metadata;
      }
    }

    return null;
  }

  private isComfyUIEvent(event: unknown): event is ComfyUIEvent {
    if (!event || typeof event !== "object") {
      return false;
    }

    const eventType = (event as { type?: unknown }).type;
    return (
      eventType === "status" ||
      eventType === "progress" ||
      eventType === "execution_start" ||
      eventType === "execution_cached" ||
      eventType === "execution_success" ||
      eventType === "executing" ||
      eventType === "executed" ||
      eventType === "execution_error" ||
      eventType === "execution_interrupted" ||
      eventType === "error"
    );
  }

  private isVhsLatentPreviewEvent(
    event: unknown,
  ): event is ComfyUIVhsLatentPreviewEvent {
    if (!event || typeof event !== "object") {
      return false;
    }

    return (event as { type?: unknown }).type === "VHS_latentpreview";
  }

  private notifyConnectionChange(state: ComfyUIConnectionState): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}
