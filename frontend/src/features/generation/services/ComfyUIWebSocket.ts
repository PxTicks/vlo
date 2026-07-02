export interface ComfyUIStatusEvent {
  type: "status";
  data: { status: { exec_info: { queue_remaining: number } }; sid?: string };
}

export interface ComfyUIProxyErrorEvent {
  type: "error";
  data: { message: string };
}

/**
 * Events consumed from the ComfyUI status websocket.
 *
 * This channel is connection-health only: ComfyUI unicasts per-job events
 * (progress, executing, executed, execution_success/error) to the submitting
 * client_id, which is the backend delivery monitor. Job lifecycle reaches the
 * frontend via the generation delivery websocket instead.
 */
export type ComfyUIEvent = ComfyUIStatusEvent | ComfyUIProxyErrorEvent;

export type ComfyUIConnectionState = "connected" | "disconnected";
export type ComfyUIEventHandler = (event: ComfyUIEvent) => void;
export type ComfyUIConnectionChangeHandler = (
  state: ComfyUIConnectionState,
) => void;

export class ComfyUIWebSocket {
  private ws: WebSocket | null = null;
  private readonly clientId: string;
  private readonly baseUrl: string;
  private eventHandlers = new Set<ComfyUIEventHandler>();
  private connectionChangeHandlers = new Set<ComfyUIConnectionChangeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

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

    this.ws.onopen = () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyConnectionChange("connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
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

  onConnectionChange(handler: ComfyUIConnectionChangeHandler): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  private handleTextMessage(data: string): void {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (!this.isComfyUIEvent(event)) {
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private isComfyUIEvent(event: unknown): event is ComfyUIEvent {
    if (!event || typeof event !== "object") {
      return false;
    }

    const eventType = (event as { type?: unknown }).type;
    return eventType === "status" || eventType === "error";
  }

  private notifyConnectionChange(state: ComfyUIConnectionState): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}
