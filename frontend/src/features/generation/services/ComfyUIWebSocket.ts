export interface ComfyUIStatusEvent {
  type: "status";
  data: { status: { exec_info: { queue_remaining: number } }; sid?: string };
}

export interface ComfyUIProgressEvent {
  type: "progress";
  data: { value: number; max: number; prompt_id: string; node: string };
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

export interface ComfyUIProxyErrorEvent {
  type: "error";
  data: { message: string };
}

export type ComfyUIEvent =
  | ComfyUIStatusEvent
  | ComfyUIProgressEvent
  | ComfyUIExecutingEvent
  | ComfyUIExecutedEvent
  | ComfyUIExecutionErrorEvent
  | ComfyUIProxyErrorEvent;

const BINARY_PREVIEW_IMAGE = 1;
const BINARY_PREVIEW_IMAGE_WITH_METADATA = 4;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export type ComfyUIConnectionState = "connected" | "disconnected";
export type ComfyUIEventHandler = (event: ComfyUIEvent) => void;
export type ComfyUIPreviewHandler = (blob: Blob) => void;
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
      const event = JSON.parse(data) as ComfyUIEvent;
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    } catch {
      // ignore unparseable messages (e.g. feature_flags)
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    if (data.byteLength < 4) return;

    const view = new DataView(data);
    const eventType = view.getUint32(0, false); // big-endian

    if (
      eventType === BINARY_PREVIEW_IMAGE ||
      eventType === BINARY_PREVIEW_IMAGE_WITH_METADATA
    ) {
      const parsed = this.parsePreviewImagePayload(data);
      if (!parsed) return;

      const imageData = data.slice(parsed.payloadOffset);
      const blob = new Blob([imageData], { type: parsed.mimeType });
      for (const handler of this.previewHandlers) {
        handler(blob);
      }
    }
  }

  private parsePreviewImagePayload(
    data: ArrayBuffer,
  ): { payloadOffset: number; mimeType: string } | null {
    const bytes = new Uint8Array(data);

    const detectMimeAtOffset = (offset: number): string | null => {
      if (offset >= bytes.length) return null;
      if (this.matchesSignature(bytes, offset, PNG_SIGNATURE)) {
        return "image/png";
      }
      if (this.matchesSignature(bytes, offset, JPEG_SIGNATURE)) {
        return "image/jpeg";
      }
      return null;
    };

    // SaveImageWebsocket payloads often include an 8-byte header before image bytes.
    const mimeAt8 = detectMimeAtOffset(8);
    if (mimeAt8) {
      return { payloadOffset: 8, mimeType: mimeAt8 };
    }

    // Some preview payloads include only a 4-byte event header.
    const mimeAt4 = detectMimeAtOffset(4);
    if (mimeAt4) {
      return { payloadOffset: 4, mimeType: mimeAt4 };
    }

    // Fallback: infer MIME from the secondary header value when present.
    if (data.byteLength >= 8) {
      const view = new DataView(data);
      const imageType = view.getUint32(4, false);
      if (imageType === 1) {
        return { payloadOffset: 8, mimeType: "image/jpeg" };
      }
      if (imageType === 2) {
        return { payloadOffset: 8, mimeType: "image/png" };
      }
      return { payloadOffset: 8, mimeType: "application/octet-stream" };
    }

    return { payloadOffset: 4, mimeType: "application/octet-stream" };
  }

  private matchesSignature(
    bytes: Uint8Array,
    offset: number,
    signature: number[],
  ): boolean {
    if (offset + signature.length > bytes.length) return false;
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[offset + i] !== signature[i]) {
        return false;
      }
    }
    return true;
  }

  private notifyConnectionChange(state: ComfyUIConnectionState): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}
